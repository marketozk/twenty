# LOG089 — native Company audit, ROB765 In Progress

Первый внутренний opt-in: `WorkspaceDataSource.transaction(work, {nativeAudit})`
для Company scalar `update`/`updateMany`. Это не автоматическое покрытие обычного
UI/REST/GraphQL. Демо и внешние коннекторы не менялись.

## Изменение

- Actor берётся из server authentication: workspaceMember, apiKey, application,
  actingAgent; system требует явный служебный ID. Metadata захватывается до await.
- Один strict transaction executor, общий audit context, flush до COMMIT. Ошибка
  mutation отравляет owner даже когда caller перехватил исключение.
- Перед before-image строки блокируются; after-image читается только для реально
  затронутых IDs. Первый before/последний after агрегируются в пределах owner.
- `crmRecord` отделён от omni parent destroy. Descriptor/event key включают
  objectMetadataId; changedFields — fieldMetadataId. Значения и пользовательские
  названия полей не сохраняются. PostgreSQL JSON-text сохраняет NUMERIC precision.
- Повтор уже закоммиченного operationId запрещён под workspace/operation lock до
  callback. Это не command replay: native receipt пока нет. Retry после подтверждённого
  rollback допустим, unknown не становится failed и не запускает слепой retry.
- Непокрытые mutation kinds, другие объекты, файловые/composite/raw-function writes
  в этом owner отказывают. Обычные repositories без opt-in пока прежние.

## Проверено

- **570 tests /22 suites PASS**,119.832s: audit, native messaging/ownership/cleanup,
  ordinary sync, parent deletion, identities/targets и auto-create; включая28 новых PG tests.
-26 guard/checksum tests PASS, dependency baseline PASS,9 migration checksums неизменны.
- Differential typecheck323 baseline/326 current roots:189/189 diagnostics,
  **0 новых и0 в изменённых файлах**. Это не чистый full-server typecheck.
-8 local/uploaded LF SHA256 совпадают. Review нашёл2 defects, оба исправлены и
  покрыты PostgreSQL tests: NUMERIC precision и operationId reuse.
- Audit INSERT fault откатывает CRM update и event callbacks; реальный потерянный
  COMMIT ACK возвращает unknown с единственным success и без ложного failed.
- Permission-denied write не меняет CRM и не пишет success. Current suite не доказывает
  будущую own-policy фильтрацию частично разрешённых batches.

Логи: [regression](regression.log), [новые проверки](native-company.log),
[types](typecheck-differential.json), [guard](dependency-guard.json),
[hashes](source-snapshot.json), [review](review.md).

## Воспроизведение и ограничения

Точный Jest filter/ограничения ресурсов — в `harness-target.py` и `harness-run.py`;
запуск изолированный, `--runInBand`, PG17, restricted role без audit UPDATE/DELETE,
Node24 image `marketozk/twenty:log088-server-fixed`,3GiB/2CPU. Source volume содержит
проверенный overlay8 файлов; image сам по себе их не содержит. Typecheck6GiB/2CPU,
полный comparison report сохранён. Harness state — исторический снимок test-only
инфраструктуры, не команда повторного создания или доступа к production.
GitHub Actions не использован. Полный frozen-image regression ранее выполнен LOG088;
новая порция проверена targeted regression, новый production image не выкатывался.

ROB765 остаётся In Progress. До общего включения нужны operation lookup index,
native entry-point wiring, остальной CRUD/merge/files, metadata/session owners,
negative audit/health и остальные [критерии](../rob765-progress.md).
