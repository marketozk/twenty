# LOG133 — аудит связей диалогов с CRM

Внутренний owner пересчитывает targets до 500 native threads по существующей
computeTargetReconciliationOperations policy. Сохраняются ручные назначения,
tombstones, live-only источники и прежняя связь с soft-deleted Company.

Аудит использует реальные INSERT/UPDATE/DELETE RETURNING и точные снимки.
Проверяются стандартная metadata, девять FK, source locks, неизменность retained
rows, ownership, неизвестные referential effects и отложенные триггеры.

В гонке с добавлением Opportunity выявлена взаимоблокировка Company/Person.
Для Company достаточно FOR SHARE: она сохраняет точный снимок, но совместима
с KEY SHARE внешнего ключа вставляемой сделки. Для Person сохранён FOR UPDATE,
который ограждает появление новых связанных сделок до COMMIT.

- [Результаты](results.json), [ревью](review.md), [следующие действия](next-boundary.md).
- [Исходники](source-snapshot.json), [тесты](target.log), [регрессия](regression.log).
- [Типы](typecheck-differential.json).

ROB765 In Progress. Owner пока внутренний; общий sweep ещё не подключён.
Сборка/выкат после LOG088 и GitHub Actions не выполнялись.
