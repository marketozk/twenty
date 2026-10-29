# LOG133 review

## Исследование и контракт

Проверены ParticipantTargetReconciliationService.reconcileMessageThreadTargets,
buildDesiredTargets, reconcileTargets и computeTargetReconciliationOperations.
Переиспользована существующая pure policy; новый бизнес-алгоритм не вводился.

Стандартные Thread/Message/Participant/Person/Company/Opportunity/Target shapes
берутся из исходного issued strict/exclusive system scope. Actual FK catalog
проверяется под table DDL locks. Исходники, tombstones и retained targets читаются
с блокировкой и сверяются до/после audit.flush и SET CONSTRAINTS ALL IMMEDIATE.

INSERT использует явные новые IDs и проверяет actual RETURNING. Пропуск
INSERT/UPDATE/DELETE допускается только при неизменности пропущенного графа.
Альтернативная строка, вставленная триггером во время ON CONFLICT DO NOTHING,
не выдаётся за проверенную плановую вставку: вся транзакция откатывается.
UPDATE разрешает только automatic flag и проверенный CURRENT_TIMESTAMP;
для входящих FK effects переиспользован assertNoReferentialUpdateEffects.

## Найдено проверками

Изначальный тест Opportunity INSERT после блокировки Person воспроизвёл
QueryFailedError: deadlock detected. Причина: вставка держала KEY SHARE Company,
ждала Person; owner держал Person и запрашивал FOR UPDATE Company.
Окончательное исправление — FOR SHARE только для Company. Эта таблица нужна
как неизменный источник, а блокировка её новых детей не требуется. Остальные
нужные parent/target locks остались FOR UPDATE. Retry или ослабление snapshots
не добавлены. Более сложное предварительное чтение Person не вошло в итог.

Dependency guard сначала обнаружил новые пути к Enterprise через общие barrels
constants/utils и ORM SQL compiler. Baseline не расширялся. Размер страницы
задан локально в пределах ORM cap; существующий FK guard использует фиксированный
позиционный параметр и булев SQL literal. В pure policy заменены только проверки
null/undefined, без изменения алгоритма. Её существующие unit tests запущены отдельно.

Независимый read-only source review native_transaction проверил actual effects,
retained rows, source parents и вызов ON UPDATE guard. Финальные исполняемые
проверки и точные количества записаны в results.json.

## Ограничения

Терминальный owner требует передачи ошибок наружу и неизменности проверенных
источников после возврата. Полный sweep должен использовать приватные стадии
в закрытом orchestrator с одним audit context и финальной проверкой всех эффектов.
HTTP, UI, deployment и customer acceptance этим срезом не заявляются.
