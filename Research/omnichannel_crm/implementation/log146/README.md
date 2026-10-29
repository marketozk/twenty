# LOG146 — календарные цели после привязки компании

Статус: узкий шаг проверен; ROB765 In Progress. [Исследование и дизайн](../log145/next-design.md), [независимое дизайн-ревью](../log145/next-design-review.md).

Существующий ReconcilePersonCompanyTargetsJob сохраняет прежнюю зависимость от TargetService. В сервисе legacy messaging выполняется первым; календарная ветка заменена закрытыми страницами по 200 кандидатов с отдельными транзакцией и аудитом. Вторая неаудируемая календарная запись не запускается.

Кандидаты выбираются по текущему Person, после блокировок повторно проверяются точные Person и Event. Цели выводятся из всех живых участников допущенных событий. Связи участников не меняются. Прежние ручные назначения и tombstones сохраняются; source SHARE защищает Person/Company/Opportunity, фактический RETURNING определяет изменения и аудит.

Вычисление полных PostgreSQL-снимков и ожидаемых generated/default значений выделено в структурный helper без новых DI-связей. Import/rematch делегируют только эти вычисления. Проверка операции аудита выделена из существующего конструктора без изменения правил и выполняется до любых legacy messaging записей.

Исходные listener triggers не расширяются. Каждая страница атомарна отдельно; успешные ранние страницы и messaging не откатываются при позднем календарном отказе. Durable delivery и общая атомарность задания не заявляются.

Полная приёмка, выкат и GitHub Actions не выполнялись. Messaging target audit, создание контактов и другие открытые строки ROB765 остаются следующей работой.

2785 tests/85 suites PASS (545.438s); 106 targeted/4 suites PASS (40.19s), 29 новых cases (24 PG и 5 job entry). 26 guard tests PASS; 10 migration checksums неизменны. Types 425/427 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 9 local/remote source hashes совпадают.

[Результаты](results.json), [ревью](review.md), [сверка исходников](source-snapshot.json).
Первоначальные два падения тестов сохранены в target-initial.log: исправлен
повторно оборачивавшийся spy тестового соединения, production не ослаблен.
Дополнительно проверены реальное generated target update и отказ при incoming
FK cascade от generated значения; отдельный rollback probe доказывает причину.

Далее: [messaging person-company targets](next-boundary.md),
[решение и проверки](next-design.md), [независимое ревью](next-design-review.md).
