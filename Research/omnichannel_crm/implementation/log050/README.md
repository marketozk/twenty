# LOG-050: parent hard-delete и корзина

ROB-764 In Progress. Ранний failclosed boundary, без включения domain destroy API.

## Реализация

`findOmniProtectedParentIds` проверяет retained core ConversationTarget по точным
workspace/objectMetadataId/recordId для всех типов, включая inactive без projection;
Person дополнительно по ExternalIdentity. Native Participant/ThreadTarget защищают
Person/Company/Opportunity; Message/Participant защищают MessageCampaign. Связь с
owned сообщением определяется существующим persisted ownership helper.

WorkspaceRepository hard-delete всегда атомарен: shared ownership fence, snapshot,
parent row locks, повторная проверка ownership и captured IDs AND original predicate.
Native write capability не разрешает parent destroy. Bypass/skipEvents не обходят
guard. Обычные email SET NULL/CASCADE сохранены, WorkspaceMember SET NULL остаётся
разрешённым без самостоятельного retained core target. Soft-delete/restore/updates
родителей сохраняют прежнюю семантику.

TrashCleanup использует те же helpers, пропускает защищённые native/parent records,
считает actual deletes, продолжает после полностью protected pages. Keyset
(deletedAt,id) хранит timestamp::text PostgreSQL с микросекундами. Retention condition
повторяется в mutation после locks. Каждая страница в отдельной strict transaction.
Shared native ownership finder используется и guard, и фильтром cleanup.

## Проверка

**1604 Jest tests /65 suites +26 guard/checksum = 1630 PASS**,
полный fork suite. 26 новых PostgreSQL случаев: 24 parent/trash и две очередности
реального history apply ↔ parent delete с подтверждённым pg_locks ожиданием.
Проверены bypass/skip/capability, direct merge kernel, mixed rollback, retained
identity/target без native projection, точный metadata ID, отказ при потере SELECT,
обычный email и member deletion, full1000 protected page с микросекундами,
equal-date pagination и concurrent restore. Миграции7 неизменны.

Typecheck 211 roots: 146 baseline/current, 0 new/changed-code diagnostics.
Это дифференциальная проверка затронутого графа, не полный server typecheck.
Dependency guard PASS, pinned baseline неизменен. Source hashes локально и в
изолированной среде совпадают.

[Full test log](tests.txt), [targeted](targeted-tests.txt),
[verification](verification.json), [typecheck](typecheck-differential.json),
[source hashes](source-snapshot.json), [dependency guard](dependency-guard.json).

## Найденное и исправленное

Independent scoped review обнаружил потерю микросекунд в JS Date cursor. Исправлено
точным pg text; соответствующая реальная PG regression проходит. Следующий review
не нашёл blockers в этом diff. Первый прогон потребовал исправить только fixture
userId/sync callback. Новый dependency edge через getWorkspaceContext отклонён:
metadata ID передаётся из существующей cache selection, baseline не ослаблен.
Полный Claude cross-review не повторялся.

## Следующие границы

WorkspaceService delete/soft-delete запускает membership/uninstall/schema/file
effects до core.workspace FK refusal; следующий guard обязан отказать до первого
side effect и исключить first bootstrap race. Core metadata guards также требуют
общего fence с mutation. Domain parent destroy/unbind/merge, audit и собственный
ACL ещё не включены; ранний отказ не является готовым разрешённым purge.
Explicit ConversationTarget projector остаётся будущей работой ROB-766.

Демо, реальные Telegram/MAX, SaleBot не менялись. GitHub Actions не использовался.
