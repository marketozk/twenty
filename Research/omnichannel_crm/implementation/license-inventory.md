# Исходные лицензионные границы интеграции

Актуальный проектируемый контракт автоматизации — [design/09](../design/09-automation-contract.md), связанный с [source matrix](automation-source-matrix.md). Исторические предположения/сокращения ниже не заменяют его; факты pinned source сохраняются. Авторские исправления ожидают независимой проверки.

Снимок `729f6236126eddaa68d176fb766bc349b19de11d`. Это инвентарь просмотренных точек, не завершённый SBOM будущей реализации. Новые dependencies проверяются при добавлении.

| Источник | Наблюдаемая маркировка | Использование |
|---|---|---|
| Корневой LICENSE, строки 2–10 | AGPLv3 по умолчанию; исключения Enterprise и MIT toolkit | Сохранять upstream LICENSE и notices; форк не объявляется свободным от условий исходной лицензии |
| ORM manager/data-source/repository/query-builder, common query runners | Нет заголовка Enterprise в просмотренных файлах | Точки интеграции своей политики/аудита; транзитивные imports могут быть Enterprise-marked и вызываются без entitlement check; header вызывающего файла не доказывает независимость |
| Messaging services и AI/workflow paths из source reports | Обычные исходники; зависимости проверяются отдельно | Переиспользовать storage/engine, добавлять собственный scope/admission |
| `engine/core-modules/event-logs/event-logs.service.ts` | `@license Enterprise` | Не использовать как backend собственного audit UI |
| `engine/core-modules/record-share/services/record-access-policy.service.ts` | `@license Enterprise` | Не использовать buildEventRecordAccessGate как свой бесплатный admission |
| `engine/twenty-orm/utils/{resolve-row-level-permission-record-filter,render-row-level-permission-filter-to-sql,is-record-matching-rls-row-level-permission-predicate}.util.ts` | `@license Enterprise` | Не копировать RLS compiler/matcher; свой predicate от собственных требований |
| Существующие внешние Telegram/MAX-коннекторы | Ревизии в research-connectors.md; перенос ещё не выполнялся | Перед переносом фиксировать LICENSE конкретного checkout и все заимствуемые файлы |

Образ этого обновления собирается из upstream runtime без изменения license/entitlement gates, без активации Enterprise key. Для собственной реализации обязательна проверка поведения без такого ключа и актуализация этой таблицы по фактическим импортам.


## Уточнение четвёртого раунда (26.10.2026)

`build-row-access-policy.util.ts` импортирует Enterprise-marked `buildRecordShareGate`, named grant helpers и renderRowLevelPermissionFilterToSql; buildRecordShareGate вызывается в обычном не-system пути. Флаг resolveObjectSharing управляет дополнительным sharing, а не доказанным отсутствием всех вызовов PRIVATE/INHERITED. Ранее написанное «без активации ключа» описывает конфигурацию демо, не отсутствие коммерческих runtime dependencies.

Прочитан корневой LICENSE pinned snapshot: default AGPL с явно выделенными Enterprise-marked файлами; коммерческий раздел отдельно ограничивает production и разрешает development/testing без подписки. Эти условия не подменяются техническим отсутствием key-check. Текущие права использования/распространения не выводятся из успешного запуска.

План для D-18: [implementation-spec §15.13](../plan/implementation-spec.md#1513-независимость-прав-от-enterprise-runtime) — независимый baseline readability + own row ACL; transitive import/DI/bundle manifest и fail-closed production gate G18. Enterprise implementation не копируется и её license gates не удаляются. До релиза все выбранные зависимости классифицируются; неопределённые rights/ownership блокируют соответствующий runtime release. T20 подтверждает собственную приватность при отсутствии/throw-инструментировании Enterprise providers, а не только при отсутствии ключа.

Release checklist G18: проверить исполнение требования Corresponding Source offer по тексту корневого LICENSE, AGPL §13, для изменённой версии с сетевыми пользователями; это отдельная проверка от исключения Enterprise dependencies и не заявление о правовом статусе текущего экземпляра.
