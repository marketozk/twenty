# Покрытие требований подробным планом

26.10.2026. Это карта проектирования и будущих проверок, не результаты runtime-тестов. Основной контракт — [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15. Номера R/F взяты из [requirements.md](../requirements.md).

| Требование | Где реализовать по плану | Проверки и gate |
|---|---|---|
| R-01 / F-01: независимость от SaleBot | §8,12; ROB-768/771, отдельные transport adapters | T11,T20; inventory функций перед переходом |
| R-02: переиспользование Twenty | §2,4,7,9,15; интеграционные карты исходников | Регрессии email/CRUD/workflow; T02,T08,T14,T22; отдельные механизмы только при доказанном разрыве контракта |
| R-03: оба канала Telegram/MAX | §4,8,10,15.2; ROB-768/770 | T01,T11,T16,T17; capabilities выбранных версий и тестовые аккаунты |
| R-04: подключение аккаунтов | §8,13,15.1; ROB-768 | T11; транспорт отдельно, вход/QR внутри CRM остаётся продуктовым решением |
| R-05 / F-07: импорт | §5,10,15.2,15.4; ROB-770 | T16,T18,T29; source identity/диапазон/retention |
| R-06,R-10 / F-04: ИИ и действия CRM | §9,15.3; ROB-769 | T13,T14,T25–T28; provider/budget/knowledge/auto policy |
| R-07 / F-05: исключение робота | §1,13 | Нет tender API, данных и операций в target scope |
| R-08: документы и код в проекте | §2,14; PROJECT/DEVLOG/Linear | Git фиксирует полный пакет; внешние transport исходники переносятся только с SHA/лицензиями |
| R-09 / F-02: совместная работа менеджеров | §7,8,15.1; ROB-766/768 | T08,T10,T12,T21; отдельные пользователи, grants, internal notes и авторы |
| R-11 / F-08: сделки/этапы | §7,15.5; ROB-766 | T08–T10,T30,T31; матрица ролей и optional multiple pipelines |
| R-12: собственные права без подписки | §1,7,15.1,15.3; ROB-766 | T08,T20,T21,T25; без копирования Enterprise implementation/gate bypass |
| R-13 / F-09: аудит | §3,6,15.5; ROB-764/765/767 | T02,T06,T07; catalog, effective DB grants, retention |
| F-03: связи с CRM | §3,4,7,15.2 | T02,T08,T23; подтверждённая identity, merge/delete/restore |
| F-06: рабочие процессы | §5,9,15.3; ROB-769 | T13,T14,T16; durable admission, scoped tools, explicit send route |
| Надёжность/эксплуатация | §4,5,10–12,15.4–15.5; ROB-764/770/771 | T01–T05,T15–T19,T26–T29,T33; ограниченная модель отказов, восстановление и single sender |

Выбор внешних групп и дополнительных Bot API аккаунтов не подтверждён и не подменяется совместной работой сотрудников внутри CRM. Все настройки реальных аккаунтов/ролей/моделей и опасные операции остаются отдельными gates, как указано в спецификации. План не требует отдельного постоянного демонстрационного экземпляра.

Авторская редакция после R7: R-06/R-10/F-04/F-06 и надёжность детализированы в [design/09](../design/09-automation-contract.md), включая T25-A/B/C, T14-A/B/C, T27-A/B/C и T28-A. Это расширения существующих групп T01–T33, не выполненные тесты и не дополнительные закрытые замечания. Source matrix связывает реальные entry points с изменениями и ожидаемыми исходами.

R8 targeted correction: T25-D/E — workflow action и provider-native paths; T27-A — canAskHumans/AI_AGENT; T14-D — native Retry до/после disposition; T27-C/D — inherited burst set и видимый handoff при занятом slot. Всё остаётся планом тестов.

После R8 A/B: F-06 проверяется также T14-E/T25-F (DATABASE_EVENT/CRON/WEBHOOK/MANUAL, causation, budget, цикл); F-03 — T23 mixed email/omni merge; T14-F — отсутствие скрытого upstream step retry; T19 — policy row contention. Все проверки будущие.

После R9 A: T13/T24 — controlEpoch отдельно от automationEpoch; T26/T27 — reply quota только в Command commit; T18/T29 — invalidation и external access reconciliation после restore; T22 — TrashCleanup lifecycle; G19 — подпись менеджера. Ни один runtime тест не запускался.

R10 corrections: T27-B root sharing разных omni event kinds; T14-E durable governed catalog vs publish/cache; T10/T13 stage/identity policy writers; T12/T24 accepted human vs auto; T15/T17 attachment reparent; T18 signing/encryption legacy fallback; T22 workspace destroy inventory. Это всё будущие тесты, не результаты.

R11: [decision-tables](decision-tables.md) содержит E01–E15, P01–P13 и C01–C18. T14 дополняется canonical core/legacy alias, sticky producer coverage/empty snapshot, pinned version и cancellationEpoch; T28 проверяет уже созданные Commands после deactivate/delete; T12/T24 — accepted/cancelRequested human gate; T10 — human target binding отдельно от non-human captured scope. [Абстрактная модель](verification/check_decisions.py) — executable specification ограниченной части таблиц, не пройденные T-тесты; результаты runtime остаются неизвестны.
