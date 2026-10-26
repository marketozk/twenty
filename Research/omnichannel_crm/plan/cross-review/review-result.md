# Итог кроссревью — R11, 26.10.2026

R11 завершил конечную проверку таблиц событий, прав и Command lifecycle. После исправлений Claude Code дал `bounded_tables_ready` в reconciliation: пять переоткрытых причин закрыты в пределах R11; остальные48 сохраняют прежнюю сверку. Всего53 известных ID closed_in_plan, open0. Это **не свежий полный pass проекта**. ROB-772 In Progress, ROB-764 Todo; новые функции и runtime-тесты не начаты.

## Что сделано

- [Конечные таблицы](../decision-tables.md): E01–E15, P01–P13, sender×mode и C01–C18. Включают roots/catalog/ID/version, policy writers, отмену, Message/Attachment ownership и ссылки на будущие T-тесты.
- Исправления внесены в spec, design/09, API, схему и этапы1/5. Accepted и cancelRequested учитываются до auto; локальная отмена отделена от подтверждения userbot; workflow IDs нормализуются; sticky coverage требует snapshot даже для empty; explicit deactivate отменяет также уже созданные Commands через workflowCancellationRefs. Human не требует captured LLM scope.
- [Модель](../verification/check_decisions.py) реально выполнена: **1712 случая,23 контрольные поломки обнаружены**. [Вывод](../verification/model-result.json). Это исполняемые примеры плана; guards не являются независимым доказательством runtime. SQL/locks, полный inventory writers/producers, Message uniqueness/Attachment XOR, актуальность ACK и fencing транспорта требуют будущих T-тестов.
- [Первый bounded A](claude-r11-finite-a.md) и [повторный bounded A](claude-r11-finite-final.md) нашли по3 major; второй содержал patch-induced omissions. Исправлены конкретные контракты и oracle, затем [B](claude-r11-reconciliation.md) подтвердил пять затронутых ID. Все отзывы и snapshots сохранены.
- Claude Code reported model claude-opus-5-5, только Read/Grep/Glob; [audit](cli-tool-audit-r11.json). Во втором A Grep случайно показал строки STATUS/cross-review: это раскрыто reviewer, чистым blind проходом его не объявляем.

## Допуск и следующий шаг

Конечная сверка выполнена; конкретных незакрытых findings R11 нет. Однако её scope уже полного проекта и итог получен в reconciliation. Поэтому ROB-772 не переводится в Done, а ROB-764 пока не начинается. Общий acceptance требует итогового свежего прохода всей исправленной спецификации без старых реестров в контексте; ещё одна одинаковая серия в этой работе не запускается.

Следующий проверяемый результат — общий verdict по уже зафиксированной редакции, с изолированным пакетом технических документов вместо Grep по архиву ревью. После положительного общего допуска — ROB-764: additive schema/inbox/outbox/audit skeleton с реальными transaction/duplicate/crash tests. G01–G20 остаются настройками до соответствующей активации; реальные сообщения и переключение каналов этой проверкой не разрешены.

Статический контроль источников и документов не заменяет T01–T33. Внешние Python connectors в R11 не перепроверялись; квалификация SHA/контрактов обязательна до переноса. Работающий экземпляр Twenty не менялся.

[Реестр](registry.md) · [Спецификация](../implementation-spec.md) · [Статус](../../STATUS.md) · [Журнал](../../DEVLOG.md).
