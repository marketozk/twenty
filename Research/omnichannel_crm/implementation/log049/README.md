# LOG-049: native mutation boundary

ROB-764 остаётся In Progress. Это ранняя защита собственного native graph по
spec §15.1/T05/T22, без публичного ACL, API или включения транспорта.

## Реализация

- WorkspaceRepository перехватывает insert, update/batch, save/upsert, merge kernel,
  hard/soft delete и restore для шести native типов. Ownership проверяется по БД,
  включая inactive binding, MessageLink, Conversation и soft-deleted association.
  Header prefix не является доказательством владения. Проверяются before/after
  родители, включая association и folder у folder junction.
- Под блокировкой строки перечитываются; mutation ограничен проверенным набором
  IDs с сохранением скобок исходного OR. Mixed batch откатывается целиком.
- Флаги bypassPermissionChecks/skipEvents и exclusive mode не дают права записи.
  Capability привязана к реальному выданному strict scope, executor, workspace,
  repository и lifecycle. Поддельный/скопированный/изменённый/закрытый scope отклонён.
- Shared ownership fence берётся каждой workspace transaction до row locks.
  Typed history/sent и binding bootstrap берут exclusive в начале. Это закрывает
  окно первой привязки при отсутствии policy row и исключает обратный порядок
  блокировок при multi-object mutation. Нормативный владелец —
  [lock protocol](../../plan/contracts/access-control.md#lock-protocol).

## Проверка

Полный набор: **1578 Jest tests, 64 suites**. Первый полный прогон дал 1567 PASS
и 11 ошибок единственного reconciliation suite: старый fixture создавал protected
graph через теперь запрещённый generic writer. Исправлена только подготовка
данных, повторён весь suite: **18/18 PASS**. Production source не менялся после
полного прогона; [полные хеши](full-source-hashes.json) и
[конечный snapshot](source-snapshot.json) это подтверждают. Это full + affected
rerun, а не утверждение о едином полностью зелёном прогоне.

Новые 74 PostgreSQL cases проходят: все mutation kinds/типы, ownership reassignment,
mixed rollback, обычный email/APP, forged/foreign/expired scope, отсутствие права
читать ownership, OR phantom, first binding и history/generic races, folder parents.
Реальный pg_locks подтверждает ожидание fence. Обычные email/rematch/cleanup
regressions проходят; fixture construction использует typed capability, проверяемые
операции выполняются без неё.

20 dependency +6 checksum tests PASS; dependency scan без новых нарушений,
все7 immutable migration sources сохранены. Дифференциальный typecheck 208 roots:
146 baseline/current diagnostics, 0 новых/0 changed-code. Единственная диагностика
в изменённом aggregate принадлежит прежнему нетронутому методу; проверена точность
diff (ровно две опции lock). Полный server typecheck не заявлен.

Два read-only scoped review, найденные замечания исправлены; полный Claude pass
не повторялся. [Результаты](verification.json), [full log](tests.txt),
[affected rerun](target-final.txt), [typecheck](typecheck-differential.json),
[dependency guard](dependency-guard.json).

## Границы и продолжение

Child repository guard не перехватывает FK CASCADE/SET NULL от удаления Person,
Company, Opportunity или иных родителей. Следующий шаг закрывает parent hard-delete
и retained core references, затем оставшийся T22 inventory. Raw/core SQL и workspace
purge требуют собственных entrypoint guards. Полный native audit — ROB-765,
runtime ACL — ROB-766; этап ROB-764 ещё не принят.

Проверки в отдельной временной PostgreSQL/Redis среде с лимитами ресурсов.
Демо, реальные Telegram/MAX и SaleBot не менялись. GitHub Actions не использовался.
