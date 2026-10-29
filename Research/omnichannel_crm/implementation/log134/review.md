# LOG134 review

## Связность и повторное использование

Сохранены проверенные реализации LOG131–133, перенесённые в приватные стадии.
Общий scope проверяется как исходный issued strict/exclusive system scope;
metadata и table DDL locks готовятся до записи. Публичного skip-audit/context
injection/callback режима нет. Один context фиксирует все actual effects;
все validators повторяются после flush и выполнения deferred constraints.

Message pages используют keyset и двигают cursor даже через protected-only pages.
affectedThreadIds собираются из actual deleted Message before-images.
Reconciliation выполняется один раз после всех message pages, только для locked
threads с живыми surviving messages; это убирает промежуточные create/delete
target события между страницами. Empty-thread deletion следует после reconciliation,
поэтому его снимки retained targets уже соответствуют итоговому состоянию.

## Исправлено при независимом ревью

Фильтр surviving threads первоначально терял снимки исключённых источников.
Late audit trigger мог восстановить soft-deleted Message/Thread без пересчёта.
Теперь FK проверяется перед фильтром, сохраняются все исходные Thread/Message
snapshots, включая исключённые. Readback включает исходные parent IDs и child IDs.
Отсутствие Thread разрешает только приватный набор actual DELETE RETURNING IDs,
заполняемый стадией удаления после проверки. Это также покрывает skipped DELETE
пустой ветки с последующей вставкой Message триггером.

Повторное независимое чтение delete_entry_tests не нашло новых конкретных
блокеров. Ревью само по себе не считается выполнением тестов.

## Точки входа и CLI

Captured workspace/identity до awaits: channel cleanup, account cleanup,
blocklist job, reset-channel и remove-orphans. Actor не берётся из payload.
Для разных транзакций используются новые operation IDs и общая correlation.
Account cleanup по-прежнему workspace-wide.

Remove-orphans больше не поглощает исключения и не изменяет данные в dry-run.
Unsafe errors проходят actual iterator/runner тем же instance, даже при сбое
eviction/logging; existence-check не выполняется после unsafe outcome.
Обычные ошибки сохраняют прежний report/continue контракт. Существующая очередь
LOG126 используется без второго retry protocol.

## Проверки и границы

Полный rollback сообщений/участников/targets/threads, actual effects и единая
operation; >500 message pages/protected-first-page; >200 target INSERT; отказ
на второй странице после подтверждённого первого DELETE; lost COMMIT ACK;
late ownership/deferred/source restoration; actual jobs/CLI и dry-run.
Начальные три падения тестов относились к JSONB key ordering и readonly SWC
exports для spy; проверки исправлены без изменения production behavior.
В typecheck также исправлен test-only widened boolean: repository permission
options сохраняют literal true через as const. Новых диагностик после этого нет.

Сохраняется один проход, как прежде: финальное удаление пустого thread может
каскадом убрать association к Message другой ветки. Такое сообщение становится
orphan после message phase и очищается следующим запуском. Проверены два
отдельных прохода, а не введён неограниченный fixed-point loop.

Это не выкат, не полный HTTP/JWT и не приёмка всего ROB765.
