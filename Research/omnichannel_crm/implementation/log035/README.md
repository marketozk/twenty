# LOG-035 — защита метаданных до побочных действий

Persisted ownership helper проверяет binding любого статуса и косвенные native
association → MessageLink/Conversation/другая bound association. Учитываются
soft-deleted rows. Channel/account защищаются целиком; folder — прямой binding
родительского канала или собственная protected junction, поэтому обычная папка
в том же косвенно защищённом канале остаётся доступной. UUID snapshot/normalization,
batches200, tenant predicates и fail-closed результаты проверены.

Account disconnect/deleteMany/transfer/update проверяются до hooks, OAuth revoke,
webhook stop и DB mutation. Batch с protected account отвергается целиком до
любого ordinary account. Generic/APP channel update/delete сохраняют прежние
проверки существования/доступности; пустой APP update остаётся read-only no-op.
Destination account scalar проверяется в том же workspace и на ownership.

Generic update больше не допускает смену id/workspace или обход scalar guards
через relation object. Generic create отвергает supplied ID до repository.save,
который иначе может выполнить update. Текущие create callsites IDs не задают.
Проверен фактический TypeORM UpdateQueryBuilder: relation referencedColumn
извлекает join ID из объекта, поэтому это реальный обход формы параметров.

Reset фиксирует список IDs, исключает protected до cache и использует один список
для channel/folder/pending updates. Folder actions проверяет snapshot workspace/
channel, исключает owned до import/cleaner и не очищает их pending action/metadata.
Ошибка отдельной ordinary folder остаётся видимой в логе и сохраняет retry;
нормализация unknown исключает аварийный выход из catch для string/null.

## Проверки

[667 полного прогона](tests.txt), [финальные86 focused](target-final.txt),
[сводка](verification.json), [TypeScript](typecheck-differential.json),
[harness](typecheck-differential.cjs), [guard](dependency-guard.json),
[9 исходников](source-snapshot.json). 2 финальных новых кейса дают669 distinct
Jest +25 Python =694 PASS; полный667 прогон предшествует только исправлению
enum test types и нормализации catch, затронутые3 suites повторены полностью.

21 metadata-ownership suite case использует PostgreSQL/native fixture (в том числе
контрактные invalid-query/input cases). 44 mutation +21 native effects unit cases
вызывают реальные service methods с моками repositories/external effects;
это не полный Nest DI/bootstrap или сетевой OAuth test. Проверены порядок effects,
смешанные списки, все ownership markers, пустой bound канал, tombstones, чужой
tenant, соседняя обычная папка, input mutation across await и SQL failure.

133 roots:149baseline/146current,0 новых/0 changed-file diagnostics. Устранены3
старые ошибки catch в изменяемом методе, остальные146 baseline сохраняются.
Увеличен только лимит одноразового typecheck runner после проверки свободной RAM:
6GiB/2CPU, Node heap4608MiB; baseline/current одинаковая среда. Это не fullserver
build/typecheck pass. Scoped независимое ревью завершено после исправления обходов.
Все5 migration checksums неизменны. Демо/production не менялись, Actions не запускался.

## Оставшиеся границы

Preflight не сериализует concurrent adoption/binding creation с внешним disconnect:
нужен будущий domain lifecycle fence. Прямые repository/generic CRUD и остальные
scheduler entry points не объявляются закрытыми. Reset caller может отдельно
поставить задачу после filtered reset; защита всей scheduler цепочки ещё впереди.
Новые проверки не создают production ACL и не активируют реальные коннекторы.
Следующий шаг — первое атомарное Conversation/Thread при receipt apply и recovery;
ROB-764 In Progress, T05 целиком не завершён.
