# Независимое ревью `LOG-215`

Дата: 25.11.2026
Режим: независимый субагент с проверкой всех 8 сущностей, миграции #11, `crm-access-foundation.schema.json`, манифеста и PG 17 тестов против `implementation-spec.md` (§3, §7, §15.12, §15.17, §15.27) и `contracts/access-control.md`.

## Итог

- Blocker: 0.
- Major: 5 - все 5 исправлены и повторно проверены на PG 17.
- Minor: 3 - 2 исправлены в срезе, 1 смежный риск (`omni-workspace-deletion.ts`) зафиксирован для `LOG-216`/`LOG-218`.

## Закрытые замечания

1. **Major #1 (имена `PK`/`FK` vs `TypeORM DefaultNamingStrategy`):** в `crm-access-foundation.migration.ts` перенесены точные имена `PK_<hash>` и `FK_<hash>` из `TypeORM SchemaBuilder.log()`, переснят `crm-access-foundation.schema.json` и добавлен PG 17 тест, доказывающий `0` diff `SchemaBuilder` по всем 8 таблицам `crm*`.
2. **Major #2 (разрушительный `down()`):** в `down()` добавлен `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` на все 8 таблиц и проверка пустоты строк с отказом `CRM_ACCESS_FOUNDATION_ROLLBACK_REQUIRES_RECONCILIATION` при наличии данных + негативный PG 17 тест.
3. **Major #3 (домен `principalKind`):** до заморозки миграции #11 домен `CRM_ACCESS_PRINCIPAL_KINDS` и 3 `CHECK`-ограничения расширены значениями `'apiKey'` и `'workflow'`.
4. **Major #4 (пробелы по краям в `UNIQUE` и `crmStageRule`):** `btrim(col) <> ''` заменён на `btrim(col) = col AND col <> ''` во всех ключевых текстовых полях (`name`, `resourceKind`, `action`, `optionValue`, `fromValue`, `toValue`, `artifactKind`), закрыт обход `' * '` и `' opportunity '`.
5. **Major #5 (глубина PG 17 тестов):** все негативные проверки привязаны к точным SQLSTATE (`23505`/`23503`/`23514`/`23502`) и именам `constraint`/`column`; добавлены тест 3-колоночного FK `crmQueueGrant` с чужим `bindingId` того же workspace, дрейф `CHK_crmStageRule_shape` и partial index без `WHERE`, отказ при неучтённой таблице, `NULL`-проверки `crmStageRule`, `'collaborator'` и отказ `down()` на непустой таблице.
6. **Minor #1 и #3:** закреплён исторический срез `FORK_MIGRATIONS.slice(0, 11)` / `FORK_SCHEMA_CHECKS.slice(0, 11)`, убрано сокращение `qr` -> `queryRunner`, добавлено `update: false` на неизменяемые ключевые колонки и синхронизирован `design.md`.

## Смежный риск на следующие срезы

- **Minor #2 (`omni-workspace-deletion.ts`):** `assertWorkspaceUnowned` сканирует только `c.relname LIKE 'omni%'`, тогда как новые таблицы `core."crm*"` имеют `FK ("workspaceId") REFERENCES core.workspace(id) ON DELETE RESTRICT`. Зафиксировано в [next-boundary.md](next-boundary.md) для закрытия в `LOG-216`/`LOG-218` до записи данных в `crm*`.
