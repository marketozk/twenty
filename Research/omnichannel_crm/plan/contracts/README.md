# Владельцы нормативных определений

Изменение контракта вносится у одного владельца. API перечисляет операции, этапы — работы и проверки, decision-tables — производные сценарии. Они не задают другую семантику; расхождение исправляется вместе с производным сценарием, а не новым поздним уточнением.

| Определение | Единственный владелец |
|---|---|
| Entities, поля, FK, UNIQUE, индексы | [Спецификация §3](../implementation-spec.md#3-схема--rob-764) |
| IDs, roots, run identity, dispatch, tools, budgets, отмена и recovery workflow | [Выполнение workflow](workflow-execution.md) |
| Permissions snapshot, scope, epochs, locks, sender×mode, control CAS, close/reopen | [Права и управление](access-control.md) |
| Command, reply, FIFO, human stale-view, timeline и SSE | [Отправка и UI](sending-ui.md) |
| Прочие контракты, аудит, миграции, lifecycle, эксплуатация | [Спецификация](../implementation-spec.md) |
| Настройки владельца G01–G20 | [Спецификация §13](../implementation-spec.md#13-единый-реестр-решений-и-gates) |

Старые §15.x сохранены как адреса ссылок. Исторические review snapshots неизменяемы и не определяют текущий контракт. Консолидация не означает реализацию или прохождение будущих T01–T33.
