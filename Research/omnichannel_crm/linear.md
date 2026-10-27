# Задачи Twenty CRM в Linear

[Открыть проект «Twenty CRM — общение с клиентами»](https://linear.app/robotrts/project/twenty-crm-obshenie-s-klientami-eccda8a60c7b).

Project ID: `91430f52-9c1d-4c25-b2d3-bf251ca39f4f`. Команда: RobotRTS (`ROB`), единственная доступная при создании. Это административный контейнер задач; интеграция с тендерным роботом по-прежнему исключена. Не создавать дубли проекта/задач при продолжении работы.

| Задача | Документ / объём | Зависит от |
|---|---|---|
| [ROB-762](https://linear.app/robotrts/issue/ROB-762) | [Архитектура и ревью плана](review.md), выполнено | — |
| [ROB-763](https://linear.app/robotrts/issue/ROB-763) | [0. Обновление экземпляра и завершение исследования кода](plan/current-steps.md) | ROB-762 |
| [ROB-772](https://linear.app/robotrts/issue/ROB-772) | [Подробный план всего проекта](plan/implementation-spec.md), [кроссревью Claude Code](plan/cross-review/registry.md) | После исследования ROB-763 |
| [ROB-764](https://linear.app/robotrts/issue/ROB-764) | [1. Модель, inbox/outbox, надёжное сохранение](plan/phase_1_data.md) | ROB-763, ROB-772 |
| [ROB-765](https://linear.app/robotrts/issue/ROB-765) | [2a. Сбор аудита](plan/phase_2_audit.md) | ROB-764 |
| [ROB-766](https://linear.app/robotrts/issue/ROB-766) | [3. Собственные права и переходы сделок](plan/phase_3_access.md) | ROB-764, ROB-765 |
| [ROB-767](https://linear.app/robotrts/issue/ROB-767) | [2b. Просмотр и экспорт аудита](plan/phase_2_audit.md) | ROB-765, ROB-766 |
| [ROB-768](https://linear.app/robotrts/issue/ROB-768) | [4. Коннекторы и чаты Telegram/MAX](plan/phase_4_chat.md) | ROB-764, ROB-765, ROB-766 |
| [ROB-769](https://linear.app/robotrts/issue/ROB-769) | [5. ИИ и workflow](plan/phase_5_ai_workflow.md) | ROB-767, ROB-766, ROB-768 |
| [ROB-770](https://linear.app/robotrts/issue/ROB-770) | [6. Вложения и импорт](plan/phase_6_history.md) | ROB-764, ROB-765, ROB-766, ROB-768 |
| [ROB-771](https://linear.app/robotrts/issue/ROB-771) | [7. Приёмка и подготовка перехода](plan/phase_7_acceptance.md) | ROB-769, ROB-770 |

Это задачи по этапам, не оценка «одна задача = один коммит». При начале этапа при необходимости выделять подзадачи из его проверяемых порций, сохраняя родительскую задачу и критерии готовности. Разделение 2a/2b сделано сразу из-за разных зависимостей.

Импорт можно разрабатывать одновременно с ИИ после общих зависимостей. Но ROB-770 нельзя закрыть до совместной проверки с ROB-769: старые сообщения не запускают ИИ и общие workflow triggers. ROB-771 закрывается по приёмке и готовому плану перехода; сам живой переход требует отдельного разрешённого действия.

Актуальные статусы — в Linear. Первоначальный снимок статусов — [DEVLOG, запись LOG-002](DEVLOG.md). Описание задачи содержит критерии и ссылку на документ; при изменении плана обновлять соответствующую задачу. Отчёты о работе — в DEVLOG и комментариях задачи, а не только в чате Codex.

## Сверка текущего состояния — 27.10.2026

LOG-021 / ROB-764 In Progress: после принятия плана реализованы9 core entities,
fork migrations и подключение migrator/gate к startup. Полный image build,
fresh/populated upgrade/replay и настоящий restart проверены. Чаты и приём/отправка
ещё не реализованы, live deployment этой порции не выполнялся. ROB-772 Done
как планирование; R16 остаётся историческим, нового полного pass не заявлено.

[Итог R16](plan/cross-review/review-result.md). ROB-762/763 Done; ROB-772 Done по решению владельца начать реализацию; ROB-764 In Progress; ROB-765–771 Backlog. Зависимость ROB-772 → ROB-764 сохраняется как выполненная предпосылка. [Ход реализации](implementation/rob764-progress.md) · [Проверки LOG-021](implementation/log021/README.md).

Предыдущая публикация R13: `183039a3c16b0e4b4a3495805ba42bf9e0d51e76`, [комментарий LOG-015](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-1df99847); read-back всех11 описаний и прежних статусов подтверждён.


Публикация R14: `be6f6cf93ad834fdade377f01ca98201850477c2`, [отчёт LOG-016](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-a1e260b1); read-back11 descriptions/unchanged states и dependency подтверждены.


Публикация R15: `41e3b3667d006c1651dc2a7e72925c06ae53fd24`, [отчёт LOG-017](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-bd21f234). Проверены11 описаний, прежние статусы и зависимость ROB-772 blocks ROB-764.


Публикация R16: `f5d806119250cdf589de20cd755da1552e079b14`, [отчёт LOG-018](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-5cfabfd8). Проверены все 11 описаний, неизменные статусы и зависимость ROB-772 blocks ROB-764. [Метаданные публикации](plan/cross-review/publication-r16.json).


Публикация LOG-019: `28cdc295b69103074e95ce93d67117950815db83`; read-back11 задач подтвердил ROB-772 Done и ROB-764 In Progress, остальные статусы сохранены. [ROB-764 отчёт](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-8753ea7f) и [ROB-772 отчёт](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-a06f566a). GitHub CI не запустился из-за billing block аккаунта; выполненные16 PG/20 guard checks и focused typecheck проходят. [Evidence](implementation/publication-log019.json).

Публикация LOG-020: `ab0402f3fddd890fb31fb504ad4502ad9b7caa2a`; [отчёт ROB-764](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-4b311d13).
Описание/комментарий проверены чтением, ROB-764 In Progress; статусы11 задач
сохранены. 9 entities и generated migration реализованы,35 PG/25 Python tests
прошли. Оба GitHub job вновь блокированы billing до запуска. [Evidence](implementation/log020/publication.json).
