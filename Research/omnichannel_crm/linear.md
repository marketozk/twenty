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

## Текущее состояние

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Актуальные проверки и ближайшая работа — в [STATUS](STATUS.md);
критерии аудита — в [rob765-progress](implementation/rob765-progress.md).
Описание ROB765 синхронизируется с [планом этапа](plan/phase_2_audit.md);
подробный отчёт о каждой публикации сохраняется в комментарии задачи и DEVLOG.

Последняя подтверждённая сверка — [LOG146 publication](implementation/log146/publication.json):
описание, комментарий и все 11 статусов прочитаны обратно; commit/push подтверждены GitHub API.
LOG146 опубликован; описание и отчёт Linear прочитаны обратно после push.
Следующая работа — messaging person-company targets; ROB765 остаётся In Progress.
История прежних R13–R16/LOG-публикаций сохраняется в [DEVLOG](DEVLOG.md) и каталогах evidence.
GitHub Actions не используется.
