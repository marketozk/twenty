# LOG097 — native audit для пользовательских CRM objects

ROB765 In Progress. Внутренний strict nativeAudit owner теперь допускает create/update
обычных локальных объектов стороннего/custom приложения. Допуск использует реальные
workspace/object/application identifiers, isSystem/isRemote и форму таблицы. Устаревший
isCustom не используется. Три поддержанных standard objects остаются привязаны к
точным universal IDs и Twenty standard application; остальные standard names/IDs
не получают разрешение даже после подмены isSystem.

Repository передаёт фактические metadata и workspace; проверяются соответствие
object ID/name и canonical table name через существующий computeTableName. Snapshot,
redaction, File executor, permissions, validation и poisoning переиспользуются.
Public selector не расширялся: automatic UPDATE пока только standard3; custom
записи в этом срезе требуют явного nativeAudit scope.

Первичные проверки типов обнаружили только аннотации row/UUID в новом nested test;
исправлены и differential typecheck повторён до 0 новых диагностик. Первый общий
прогон нашёл устаревшую проверку прежнего текста coverage error в Company test;
ожидание обновлено без изменения runtime, общий прогон повторён.

## Проверка

766 tests / 28 suites PASS, 167.715 s; 22 новых PG cases, 114 targeted tests.
26 guard tests PASS, 10 migration checksums неизменны, dependency baseline PASS.
Types 334/336 roots, 189/189 baseline diagnostics, 0 новых/changed; full-server
typecheck не чистый. Восемь local/uploaded source hashes совпадают. После последнего
typecheck менялся только строковый expected error в старом тесте; общий regression
выполнен на окончательном коде.

- Custom create/update/updateMany, identical record UUID в standard/custom объектах
  с разными audit descriptors, агрегация update и один operation ID.
- Реальная FK ошибка и native permission denial; delete/restore не становятся
  разрешёнными через расширение create/update.
- Системные message/calendar/workflow/dashboard/task/recordShare отказываются;
  перехваченный отказ после custom mutation отравляет owner и откатывает её.
- Foreign workspace, remote/system, standard name/UID и пустое application ID
  не удовлетворяют metadata boundary.
- Custom FILES create/update используют ту же полную File fixture и executor.
- CommonCreateOne/Many создают Company→customCase→Company в explicit audited scope;
  реальные metadata/SQL/FK подтверждают один commit или полный rollback цепочки.
  ROLE_ONLY sharing не вызывает stubbed ShareWith collaborator. Это не тест shares.
- Test fixture строит custom таблицы из metadata существующими schema managers,
  FK targets и reset используют фактические имена таблиц с custom prefix.

Итоговые выводы: [results](results.json), [target](target.log),
[regression](regression.log), [types](typecheck-differential.json),
[source hashes](source-snapshot.json), [review](review.md).

Новый образ/демо не выкатывались, GitHub Actions и внешние сообщения не использовались.
Общий native CRUD/merge, core/metadata/session owners, negative audit и health ещё
впереди. Public CREATE и собственный shared access требуют следующей реализации.
Нельзя включать Enterprise recordShare в generic CRM allowlist, чтобы обойти границу.
Следующий независимый участок ROB765 — soft-delete/restore; физическое удаление и
merge требуют отдельной проверки FK side effects. Public CREATE/shared access
остаётся открытым пунктом, а не обходится через unaudited fallback.
