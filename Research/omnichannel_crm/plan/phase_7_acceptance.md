# Этап 7. Приёмка, эксплуатация и переход

Нормативные определения: [индекс владельцев](contracts/README.md). Этот документ содержит производные работы и проверочные сценарии; изменение семантики вносится у владельца и затем отражается в сценарии.

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Зависимости: все предыдущие этапы. Статус: не выполнен.

**Файлы:** `ops/omnichannel/` и актуальная конфигурация единственного экземпляра после проверки среды; `Research/omnichannel_crm/implementation/{acceptance.md,restore.md,cutover.md}`; тесты в existing server integration/front/e2e conventions. Ни реальные credentials, ни архивы переписки не входят в Git.

1. Запустить [полную матрицу](../design/04-testing.md) и аудит [08-audit](../design/08-audit.md) на Free/self-hosted без Enterprise key. Отдельно generic API, hidden groupBy labels, файлы и admin/system bypass.
2. Зафиксировать приложение/image SHA, migrator version, schema и worker version. Пробный upgrade из восстановленной копии; `upgrade:status`, записи/связи до-после, UI и jobs. HTTP health недостаточно.
3. Restore drill: PostgreSQL, файлы, connector/adapter journals и secrets отдельным безопасным способом; после восстановления reconcile внешние sends. Не запускать устаревший outbox на повторную доставку.
4. Нагрузочный профиль по реальному числу аккаунтов/менеджеров/сообщений; лимиты и мониторинг backlog/latency/unknown/audit failure. Проверить capacity audit indexes/storage; не придумывать SLA до измерения.
5. Before cutover: выбрать route/account/диапазон, дренировать прежние исходящие, разобрать unknown, сменить generation/credentials, replay непринятых событий, доказать одного dispatch owner. Согласовать конкретное окно/возврат с владельцем.
6. Проверить с отключённым SaleBot тестовый маршрут: receive/send/history/AI/workflow/audit. Инвентаризация остальных функций SaleBot должна показать, какие нужны для общения и покрыты; unrelated сервисы не переключаются.

**Verify:** журнал фактических команд и результатов, тестовые акторы, pass/fail каждого сценария, открытые ограничения. Успех сборки/CI не равен успешной приёмке клиента.

**Done when:** все обязательные сценарии Telegram/MAX, менеджеров, ИИ, истории и аудита проверены; restore/cutover rehearsal пройден; нет открытых access/delivery blockers. Живой cutover — отдельное разрешённое действие, не побочный эффект разработки.

**Rollback:** остановить новые business sends, сохранить/сверить доставленные и неизвестные команды, восстановить проверенный пакет состояния, переключить generation единственного владельца. Откат БД не отменяет отправки провайдеру; требуется reconciliation, а не слепое повторение журнала.

Restore acceptance также проверяет access fence, invalidation sessions/API keys и сверку revoke по внешнему источнику (spec §15.21); не открывать восстановленный экземпляр только по восстановленным grants.

## Уточнённые условия приёмки

Повторить T19 после раннего contention gate ROB-766. G11/G13 inventory проверяет единственного CRM-dispatch owner и посторонние источники каждого выбранного аккаунта; это не разрешение изменять внешние системы.

Restore без достоверного внешнего журнала актуальных изменений доступа заканчивается access fence/default deny; проверенный recovery-admin назначает права заново с audit. Это ожидаемый безопасный runbook outcome, не обещание автоматического возврата всех доступов. T18/T29 проверяют наличие/отсутствие доказательств. Внешний writer журнала не считается спроектированным или созданным.

T11/T18 квалифицируют single session-owner, legacy generation0 cutoff у userbot, asymmetric switch crash и fenced rollback. T29: после restore connector order определяется durable journal, outboundSequence не unique key; orphan evidence не создаёт новый send. T17/T32 проверяют payload purge manifest всех stores и отдельную backup retention. Детали §15.25.

T18/T29 проверяют fresh restoreIncarnation перед снятием fence: прежний reference/cursor с совпавшей numeric epoch отклонён; новый reference создаётся лишь после current auth/reconciliation. Это проверка [restore контракта](implementation-spec.md#1524-учёт-посторонних-отправителей-и-ожидаемый-restore-fallback), не заявление об успешном restore.
