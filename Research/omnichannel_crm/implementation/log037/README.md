# LOG-037 — bounded resume заблокированной истории

Internal typed entry resumeOmniBlockedHistoryReceipts проверяет текущую авторизацию,
active binding/current generation, canonical account/APP channel и exact disabled policy v0.
Обрабатываются только blocked_config/configuration_missing без lease/result, qualified
history_import incoming complete text с проверенными envelope/capture hashes. Неподходящие
receipts остаются заблокированными; история не переопределяется и новые receipts не создаются.

Существующий Conversation использует собственную активную queue и current policy.
Binding defaults применяются только к отсутствующему диалогу: active same-binding queue/human.
Resume не создаёт Conversation/Person/Message, не меняет targets и не допускает automation.
Следующий обычный claim повышает token/attempt; apply заново проверяет права/состояние.

Пакет1..100 сканируется по nextAttemptAt/id с существующим binding_due index prefix.
Курсор сохраняет6 дробных знаков PostgreSQL, без потери точности JS Date. Продвигается
вся просмотренная страница, включая неподходящие записи. Parent locks собраны до receipt;
receipts берутся sorted ID FOR UPDATE SKIP LOCKED и перечитываются против полного snapshot.
Новый housekeeping pass начинается без cursor: конец страницы не доказывает, что все
заблокированные записи восстановлены, пропущенные locks подбираются следующим проходом.

UPDATE сохраняет ID/envelope/capture/hash/token/attempts/result; меняет только state/error/
nextAttemptAt/updatedAt. Success audit operation стабилен на receipt+leaseToken. Facade
владеет strict native transaction; failure/denied attempt на binding пишется отдельной
транзакцией после подтверждённого rollback, неизвестный исход исключает ложный failure audit.
Невозможность записать failure audit остаётся видимой ошибкой. Все inputs/callback фиксируются
до первого await; прежние методы aggregate не изменены.

## Проверки

[Полный прогон744/745,31 suites](tests.txt), [финальный focused44PASS](target-final.txt),
[сводка](verification.json),
[TypeScript](typecheck-differential.json), [harness](typecheck-differential.cjs),
[dependency guard](dependency-guard.json), [5 исходников](source-snapshot.json).
После исправления только assertion745 distinct Jest +20 guard +5 checksum:770 PASS.
Остальной runtime не менялся между полным и финальным focused прогоном. Все5 migrations неизменны.
140 roots:146 baseline/current,0 новых/0 changed-code. Диагностика в aggregate относится
к прежнему неизменённому методу (AST/text comparison). Это не полный server typecheck/build.
Одноразовый typecheck runner6GiB/2CPU, heap4608MiB; production/демо не менялись.

37 PG cases: blocked→fixture config repair→resume→claim→реальный apply, повтор/конкуренция,
микросекунды/reversed UUIDs, полностью неподходящая страница, actual receipt-lock skip,
policy writer wait через pg_blocking_pids, чужой tenant/binding, malformed inputs,
wrong capture/variant/generation, whole-batch audit rollback и реальный COMMIT ACK loss.
7 facade unit cases: input mutation across await, denied-after-rollback ordering,
unknown commit/rollback/release, failure-audit error и отсутствие attempt до callback.
Первый focused43PASS/1FAIL ожидал raw trigger message. Полный744PASS/1FAIL уточнил:
штатный ORM оборачивает P0001 дважды (ClientQueryExecutor и transaction runner).
Исправлена проверка wrapper и исходной причины в cause chain; финальный focused44PASS
проверил также rollback assertions. Runtime не менялся; оба результата сохранены.

## Границы и продолжение

Это inert helper/facade без processor/provider/cron/HTTP. Текущие permissions callbacks
тестовые; own ACL и production activation ещё не реализованы. Исправление queue/default
в этом PG fixture выполняет owner SQL: полноценный config writer следует следующим.
Нужны durable binding.config_changed producer, typed consumer и periodic housekeeping.
Никаких фиктивных workflow execution/pinnedVersion IDs для maintenance receipts.
Scoped independent review runtime/facade без блокеров; новый Claude review не заявляется.
ROB-764 In Progress; GitHub Actions не использовался.
