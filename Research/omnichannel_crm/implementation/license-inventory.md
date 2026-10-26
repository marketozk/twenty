# Исходные лицензионные границы интеграции

Снимок `729f6236126eddaa68d176fb766bc349b19de11d`. Это инвентарь просмотренных точек, не завершённый SBOM будущей реализации. Новые dependencies проверяются при добавлении.

| Источник | Наблюдаемая маркировка | Использование |
|---|---|---|
| Корневой LICENSE, строки 2–10 | AGPLv3 по умолчанию; исключения Enterprise и MIT toolkit | Сохранять upstream LICENSE и notices; форк не объявляется свободным от условий исходной лицензии |
| ORM manager/data-source/repository/query-builder, common query runners | Нет заголовка Enterprise в просмотренных файлах | Точки интеграции своей политики/аудита; existing gated imports сами по себе не дают независимую реализацию |
| Messaging services и AI/workflow paths из source reports | Обычные исходники; зависимости проверяются отдельно | Переиспользовать storage/engine, добавлять собственный scope/admission |
| `engine/core-modules/event-logs/event-logs.service.ts` | `@license Enterprise` | Не использовать как backend собственного audit UI |
| `engine/core-modules/record-share/services/record-access-policy.service.ts` | `@license Enterprise` | Не использовать buildEventRecordAccessGate как свой бесплатный admission |
| `engine/twenty-orm/utils/{resolve-row-level-permission-record-filter,render-row-level-permission-filter-to-sql,is-record-matching-rls-row-level-permission-predicate}.util.ts` | `@license Enterprise` | Не копировать RLS compiler/matcher; свой predicate от собственных требований |
| Существующие внешние Telegram/MAX-коннекторы | Ревизии в research-connectors.md; перенос ещё не выполнялся | Перед переносом фиксировать LICENSE конкретного checkout и все заимствуемые файлы |

Образ этого обновления собирается из upstream runtime без изменения license/entitlement gates, без активации Enterprise key. Для собственной реализации обязательна проверка поведения без такого ключа и актуализация этой таблицы по фактическим импортам.
