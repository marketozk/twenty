# R14 — авторская проверка перед чтением результата Claude

Дата: 2026-10-26. Baseline: `f212cd12ddadefe88265d32fd6effdeb4dc9dcb1`.

Этот результат записан до чтения fresh-A Claude. Автор знает предыдущую историю проекта; это самостоятельная проверка текущих контрактов, **не второй слепой независимый reviewer**. Полный пакет из 39 документов передан отдельной новой сессии Claude. Runtime, внешние отправки и deploy не выполнялись.

## Проверено

- Нормативные владельцы `contracts/{workflow-execution,access-control,sending-ui}.md`, schema §3 implementation-spec и таблица операций design/06-api; производные этапы 1/6/7, тестовая матрица design/04 и контракт аудита design/08. В других документах использованы точечные ссылки и source inventory; не заявляется построчная повторная проверка всех 39 файлов автором.
- `WorkspaceTransactionScope`: третий аргумент getRepository действительно принимает shouldSkipEventEmission; executeRawQuery и afterCommit доступны. `MessagingMessageService.saveMessagesWithinTransaction` использует переданный scope, но входит в system context. Поэтому требуется предусмотренный планом узкий adapter и собственная авторизация до записи, а не доверие штатному system caller.
- `WorkspaceDataSource.transaction`: один transactional executor передаётся repository/raw SQL; afterCommit callbacks находятся только в памяти и ошибки логируются после commit. Durable outbox/audit в общей транзакции обоснован; callback не заменяет журнал.
- `WorkspaceOrmManager.runInWorkspaceTransaction` выбирает primary; loadWorkspaceContext загружает permissions/role maps из WorkspaceCacheService. Нормативный контракт primary/fenced reads с актуальными role inputs устраняет архитектурную зависимость от устаревшего cache, но ещё должен быть реализован и проверен.
- `RunWorkflowJob.handle/startWorkflowExecution`: отдельные ветки awaited output/retry/resume/start, system auth, FAILED при exception и только ENQUEUED/NOT_STARTED на старте. План охватывает ingress/continuations, запрет скрытых retry и отдельное восстановление crash; обработчик exception сам по себе не доказывает crash recovery.
- Front `getTriggerDefaultDefinition` имеет исчерпывающий switch существующих типов; `useUpdateWorkflowVersionTrigger` сохраняет coreWorkflowVersionId через Core GraphQL и пересчитывает output schema. Обязательная регистрация OMNICHANNEL_EVENT во всех switch/schema/editor sites соответствует реальному пути, а не только backend enum.

## Проверенные контрпримеры

1. Два менеджера отправляют по старому экрану: admission проверяет replyRevision, accepted-idempotency lookup предшествует CAS; доставка не сравнивается со старой UI revision.
2. Takeover/revoke/stall после создания Command: class/provenance, automation epoch, producer fence и workflow cancellation lineage повторно проверяются; неизвестный внешний исход не объявляется отменённым.
3. Потеря Redis/сбой worker: PG intent/lease/effect ledger сохраняют владение; RUNNING не переисполняется автоматически. Завершённый turn разрешает только ранее committed Command, stalled worker не получает новое право на effect.
4. Restore с повторившейся численной policy epoch: свежая restoreIncarnation отсекает старые references/cursors; отсутствие внешнего журнала доступа сохраняет default deny.
5. Import-first/live-later и повторная активация: MessageLink/admission разделены; activationVersion не расширяет ключ дедупликации; page receipt/checkpoint и author snapshots имеют schema owner.
6. Commit-before-emission crash: afterCommit недостаточен; в плане предусмотрены durable DomainEvent/intent и запрет native duplicate dispatch, включая empty plans и поздний publish.
7. Неизвестная доставка предыдущей команды: FIFO различает неизвестный enqueue и доказанное принятие транспортом; manual replacement не обходит барьер.

## Итог до сверки с Claude

Нового воспроизводимого блокирующего противоречия в проверенных контрактах и call sites не найдено. Это не доказательство отсутствия ошибок во всём проекте и не итоговый допуск: требуется результат fresh-A и сопоставление замечаний.

G01–G20 остаются решениями владельца/условиями активации по своему этапу. T01–T33 — будущие проверки реализации. Статическая проверка плана не подтверждает SQL concurrency, UI, реальные Telegram/MAX capabilities, нагрузку или production readiness. Очередной общий раунд не заменяет эти проверки при написании кода.
