# Технический план реализации CRM — v1

LOG-047 / ROB-764 In Progress: Command хранит immutable createdRestoreIncarnation.
Admission берёт её из policy под lock; первый claim требует совпадения с текущей.
NULL/старая incarnation запрещают новую отправку, replay не переписывает provenance.
Историческая сверка dispatching/accepted/outcome_unknown сохраняется, включая NULL.
Седьмая миграция additive, без default/backfill; первые6 источников неизменны.
Полный fork suite: 1460 Jest /61 suites +26 guards =
1486 PASS. Typecheck 200 roots:
146 baseline/current,0 новых/0 changed-code.
[Доказательства и границы](../implementation/log047/README.md). PostgreSQL проверяет upgrade populated prefix6,
schema drift, auth/replay, policy locks и audit/AFTER UPDATE tamper.
Независимое scoped review без блокеров; полный Claude pass не повторялся.
Далее — локальная отмена ещё не переданной команды и общий native mutation guard.
ROB-764 не закрыт; restore coordinator/provider fence, HTTP/UI/ACL/transport ещё впереди.
Демо прежнее, GitHub Actions не используется.

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Дата: 26.10.2026. Требования v0.6: самостоятельная CRM, Telegram/MAX, менеджеры, ИИ/workflow, импорт и собственный аудит; без подписки Twenty и без тендерного робота. Пользователь разрешил подготовку плана после архитектуры. Статусы ниже не означают реализацию.

| Этап | Результат | Зависимости |
|---|---|---|
| [0. Обновление и исследование кода](current-steps.md) | Один экземпляр на форке 2.52, статическая карта транзакций/прав и уточнённый план | Зафиксированный snapshot и архитектура |
| [1. Модель и надёжное сохранение](phase_1_data.md) | Conversation, receipts, outbox, ID и транзакционная основа аудита | 0 |
| [2. Аудит](phase_2_audit.md) | Сбор действий, безопасные diff, query/export и экран | 2a после 1; 2b после 3 |
| [3. Собственные права](phase_3_access.md) | Сквозная изоляция без Enterprise RLS, правила переходов | 1 + 2a; до внешней multi-manager приёмки |
| [4. Коннекторы и рабочий чат](phase_4_chat.md) | Telegram и MAX receive/send, receipts, совместный UI | 1, 2a, 3 |
| [5. ИИ и workflow](phase_5_ai_workflow.md) | Scoped tools, автоответы, takeover, automation events | 2, 3, 4 |
| [6. Вложения и история](phase_6_history.md) | Файлы, edit/delete, возобновляемый импорт | 1, 2a, 3, 4; проверка suppression также с 5 |
| [7. Приёмка и переход](phase_7_acceptance.md) | Доказанная независимость от SaleBot и проверенный откат | Все предыдущие |

Общий порядок: `0 -> 1 -> 2a -> 3 -> (2b + 4) -> (5 + 6) -> 7`. Обозначение «+» допускает независимые изменения после общих зависимостей; это не команда изменять общие файлы параллельно. Аудит начинается до первых доменных изменений и дополняется в каждом этапе.

## Конечные таблицы

[decision-tables.md](decision-tables.md) связывает event/root/catalog, policy invalidation и Command lifecycle с source inventory и T-тестами. [Модель](verification/check_decisions.py) — только исполнимые примеры плана, не реализация CRM; её пределы перечислены в таблицах. Текущий verdict — [review-result](cross-review/review-result.md).

## Правила исполнения

Шаги реализации описаны здесь и в `phase_*.md`; фактическое выполнение ведётся в [DEVLOG.md](../DEVLOG.md). [Карта задач Linear](../linear.md) содержит задачи и зависимости. После каждого рабочего шага обновлять журнал, после push — краткий отчёт в задаче Linear с доказательствами. Статус Done не ставится только по наличию плана.

- `Существующие файлы` — найденные точки интеграции; `Новые` — проектируемые пути. Перед patch повторно читать call sites и ближайшие тесты. Список не притворяется полным перечнем изменений ORM до результатов этапа 0.
- Каждый этап разбивать на ревьюируемые commits: модель/контракт, серверная операция с тестом, UI, e2e. Не коммитить секреты/данные, не менять коммерческие license gates.
- Закреплённая исходная база — `upstream-2.52.json`; runtime сборка из текущего зафиксированного SHA нашей ветки. Обновление upstream отдельной задачей.
- Узкие проверки -> integration на отдельной БД -> UI/тестовые аккаунты. `database:reset` никогда не направлять в демо/рабочую БД.
- Базовые команды взяты из CLAUDE.md/Nx: `npx nx build twenty-shared --skip-nx-cache`; `npx jest <test-file> --config=packages/<package>/jest.config.mjs`; package typecheck `npx tsgo -p tsconfig.json --noEmit`; server integration target из `packages/twenty-server/project.json` с выбранным testPath. У новых тестов точные имена фиксируются в соответствующем commit.
- Для всех собственных функций отдельная проверка с отсутствующим Enterprise key. Удаление/подмена лицензионной проверки не считается реализацией.
- Для опасных шагов сначала восстановленная тестовая копия/контрактные тесты. Живые клиентские аккаунты, импорт, отправки и переключение не выполняются этим документом.

## Проверяемые границы

Решены: форк/модули, хранение, транспорт, собственные права и аудит; один рабочий экземпляр. [Карта исходников и изменений](../implementation/integration-map.md) уточняет реальные transaction owners, core storage, raw bypass, файлы, SSE и AI/workflow. Ещё нужны: тестовые аккаунты, конкретная матрица ролей, UI login/QR, диапазон истории, media capabilities, retention и AI provider/budget. Это входные данные соответствующей приёмки; они не заменяются догадками и не мешают начать реализацию с синтетическими тестами.

Условия перехода к реализации: [review.md](../review.md), отсутствие открытых blocking findings для выбранного этапа. [Архитектура](../design/01-architecture.md), [аудит](../design/08-audit.md), [полная тестовая матрица](../design/04-testing.md).
