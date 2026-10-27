# LOG-042 — внутренняя выдача исходящей работы

Внутренний claim реализован и проверен. ROB-764 остаётся In Progress.

Реализуем ограниченный claim/FIFO/recovery на существующей OmniOutgoingCommand:
UUID leaseToken, DB leaseUntil, statusRevision. Нормативная граница —
[sending-ui](../../plan/contracts/sending-ui.md#command-states).

Первый claim virgin pending требует текущих прав captured human author, worker,
active route и квалификации транспорта; stale UI CAS admission не перепроверяется.
Истёкшие dispatching/accepted/outcome_unknown — только status/reconciliation по
старому ID, даже если прежний worker фактически не дошёл до сети. Права worker на
сверку независимы от отозванных прав автора на новые sends. Неподтверждённый FIFO
predecessor блокирует следующий first claim. Никаких provider calls внутри DB locks.

Сейчас нет production handshake verifier, закрытого accepted-evidence reducer и
внешнего restore-fence registry. Поэтому callbacks авторизации, квалификации и
проверки predecessor обязательны, default allow отсутствует; тестовые grants
явно synthetic. HTTP/scheduler/live connector не включаются. Не вводим guessed
capability flags в persisted JSON. Metadata lease не является send capability;
validate пользовательского serialized purpose/incarnation не добавляется без
durable association. После потери proof — новый reconcile-only claim по expiry.

Проверено: два worker, FIFO, expiry/reclaim, revoke автора/worker, inactive/historical
route, неверный tenant, callback snapshot, audit/DB rollback и lost COMMIT ACK.
Реальные admitted Commands и PostgreSQL, scoped typecheck, dependency/migration guards.
Миграций и произвольного status DomainEvent не требуется. GitHub Actions не используется.

## Проверки и ограничения

[194 Jest /10 suites](tests.txt), включая32 PostgreSQL cases нового claim,
и [20 dependency](guard-tests.txt) + [6 checksum](checksum-tests.txt) =220 PASS.
Полный fork suite1025 последний раз проверен в [LOG041](../log041/README.md);
здесь повторены затронутые admission/lease/audit/native transaction suites.
[TypeScript](typecheck-differential.json):170roots,146 baseline/current,
0 новых/0 changed-code. Прежний проблемный метод совпадает с baseline по AST;
полный server build/typecheck не заявляется. Все6 миграций и старые методы
aggregate неизменны. [Source hashes](source-snapshot.json) совпали с удалённым
проверенным кодом. [Dependency guard](dependency-guard.json) без нарушений.
[Сводка](verification.json).

Реальные PG triggers задерживают аудит за предел lease и подменяют token;
полный rollback проверен. COMMIT ACK теряется после фактического commit:
нет выданного proof/ложного failed audit, сохранённый lease не создаётся второй раз.
Exact DB timestamp/audit совпадают, final CAS повторно проверяет срок после аудита.
Обычные lease_live/not_due/waiting_predecessor/terminal — no-op без failure audit.

FIFO сканирует максимум100 предшественников; больше даёт явный
predecessor_scan_limit без claim. Это ограничение внутреннего writer, а не готовый
масштабируемый dispatch. Следующий reducer проверенного durable acceptance должен
дать постоянное доказательство и снять необходимость перечитывать всю историю.
Нулевой journalSequence допустим по существующей схеме; сам по себе ни0, ни другой
номер не доказывает acceptance. Необходим trusted verifier и остальные evidence.

Независимое scoped review без блокеров. Skills: ai-dev-workflow,
behavioral-guardrails, server-schrodinger; полный Claude review не повторялся.
Следующий LOG-043: сохранение verified connector acceptance, отдельно от sent/Message.
