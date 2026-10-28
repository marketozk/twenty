# Review LOG113

Read-only /root/native_transaction проверил public callsites, migration owner, roleTarget
FK/unique constraints, lock order и actual snapshots. Найденные дефекты исправлены:

- No-op обходил валидацию auth/workspace нового audit contract. Operation identity
  валидируется до первого await, отдельно от создания события; foreign/pending/missing
  identity negatives проходят и для уже назначенной роли.
- applicationId имеет обычный FK на id, а не composite tenant FK. Новый общий SQL
  verifier сверяет фактические workspace/UID/deletedAt под SHARE до writes/послеflush
  у role CREATE и assignment. Проверки missing/foreign/deleted/changed UID и trigger
  corruption добавлены для обоих owners.

Root проверил реальные UserRoleService + RoleTargetService + AI tool, stale cached
no-op, actual no-op, immutable identity/input, явный bootstrap path. Две concurrent
public admin demotions завершаются одним успехом и одним отказом; один admin остаётся.
Workspace lock выбран NO KEY UPDATE, чтобы не конфликтовать с FK KEY SHARE inserts.

Из-за отсутствия FK userWorkspaceId обнаружена отдельная pre-existing гонка с удалением
membership: deleteUserWorkspace сначала удаляет targets, потом membership. Этот writer
ещё не использует общий fence/owner, и гарантия LOG113 на него не распространяется.
Остаток явно зафиксирован в README и плане; полного role lifecycle acceptance нет.

Финальный readonly проход fresh application verifier и NO KEY UPDATE новых blockers
в заявленной assignment boundary не выявил. Уточнено: обычный workspaceMember CRUD
запрещён pre-hooks; главный public removal делает transfers/native delete до core cleanup.
Поэтому обнаруженная гонка описана как граница core сервиса, не доказанный публичный
exploit. Core membership deletion также имеет CASCADE/SET NULL effects, а workflow-share
reconciliation после него использует отдельные транзакции; объединять это механически
в существующий owner и объявлять весь removal атомарным нельзя.

1152 tests/36 suites PASS (201.448s); 98 targeted/2 suites + 11 existing role-tool unit tests PASS. 44 новых cases: 40 PG + 4 descriptor. 26 guards PASS; 10 migration checksums неизменны. Types 352/354 roots, 218/218 прежних диагностик, 0 новых/changed-code. 11 local/remote source hashes совпадают.

Full-server typecheck не чистый. [Результаты](results.json).
