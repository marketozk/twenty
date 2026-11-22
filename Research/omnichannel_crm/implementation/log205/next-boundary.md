# Следующий участок после LOG205

После завершения `LOG205` (транзакционный аудит отсоединения и долговечный post-commit owner физического удаления `FILES` `delete_filesFieldFiles` для покрытых CRM `DELETE`/`DESTROY`/`MERGE` + `CASCADE`-потомков) открытые границы `ROB-765`:

- Оставшиеся неподключённые native/core/metadata writers и lifecycle пути:
  - `TrashCleanupService` (перевод очистки корзины покрытых CRM-объектов на `nativeAudit` с системным актором) и физическое удаление мягко удалённых `FILES` после `UPDATE` `toRemove`,
  - оставшиеся session lifecycle пути (family revoke, stateless application JWT, concurrent-sign-in / in-flight fencing),
  - post-rollback denied/failed audit и алертинг для общих нативных путей,
  - оставшиеся непокрытые native/core/metadata writers и durable cache.
- Общая HTTP/JWT приёмка, сборка и выкат кандидата (`LOG089`-`LOG205`).
