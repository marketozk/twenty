# Этап 7. Приёмка, эксплуатация и переход

Зависимости: все предыдущие этапы. Статус: не выполнен.

**Файлы:** `ops/omnichannel-demo/` и отдельный production manifest после проверки среды; `Research/omnichannel_crm/implementation/{acceptance.md,restore.md,cutover.md}`; тесты в existing server integration/front/e2e conventions. Ни реальные credentials, ни архивы переписки не входят в Git.

1. Запустить [полную матрицу](../design/04-testing.md) и аудит [08-audit](../design/08-audit.md) на Free/self-hosted без Enterprise key. Отдельно generic API, hidden groupBy labels, файлы и admin/system bypass.
2. Зафиксировать приложение/image SHA, migrator version, schema и worker version. Пробный upgrade из восстановленной копии; `upgrade:status`, записи/связи до-после, UI и jobs. HTTP health недостаточно.
3. Restore drill: PostgreSQL, файлы, connector/adapter journals и secrets отдельным безопасным способом; после восстановления reconcile внешние sends. Не запускать устаревший outbox на повторную доставку.
4. Нагрузочный профиль по реальному числу аккаунтов/менеджеров/сообщений; лимиты и мониторинг backlog/latency/unknown/audit failure. Проверить capacity audit indexes/storage; не придумывать SLA до измерения.
5. Before cutover: выбрать route/account/диапазон, дренировать прежние исходящие, разобрать unknown, сменить generation/credentials, replay непринятых событий, доказать одного dispatch owner. Согласовать конкретное окно/возврат с владельцем.
6. Проверить с отключённым SaleBot тестовый маршрут: receive/send/history/AI/workflow/audit. Инвентаризация остальных функций SaleBot должна показать, какие нужны для общения и покрыты; unrelated сервисы не переключаются.

**Verify:** журнал фактических команд и результатов, тестовые акторы, pass/fail каждого сценария, открытые ограничения. Успех сборки/CI не равен успешной приёмке клиента.

**Done when:** все обязательные сценарии Telegram/MAX, менеджеров, ИИ, истории и аудита проверены; restore/cutover rehearsal пройден; нет открытых access/delivery blockers. Живой cutover — отдельное разрешённое действие, не побочный эффект разработки.

**Rollback:** остановить новые business sends, сохранить/сверить доставленные и неизвестные команды, восстановить проверенный пакет состояния, переключить generation единственного владельца. Откат БД не отменяет отправки провайдеру; требуется reconciliation, а не слепое повторение журнала.
