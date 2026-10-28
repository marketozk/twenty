# LOG106 — аудит штатного SET NULL при удалении

ROB765 In Progress. Внутренний nativeAudit delete теперь допускает непосредственные
SET NULL эффекты для covered local child metadata в том же workspace. Company →
Person/Opportunity/customCase сохраняет штатное действие PostgreSQL: ручной
repository.update не вызывается, даты и child events не добавляются.

Реальные pg_constraint должны указывать на parent.id одним relation/morph column,
с action SET NULL и согласованным metadata target. Parent FOR UPDATE исключает новые
FK-ссылки; child rows блокируются в порядке таблицы/id и перечитываются после lock.
Поэтому уже завершившееся перемещение контакта к другой компании не затирается.
Несколько FK одной строки объединяются в один update audit. Actual DELETE RETURNING
задаёт, какие связи должны стать null; остальные columns должны остаться прежними.
Before/after проверяются целиком с PostgreSQL JSON text precision.

Child update и parent delete используют прежний audit context/executor. Audit failure,
postcondition failure и caught error откатывают весь граф; unknown COMMIT не вызывает
повтор. Условия, права и события штатного DB cascade сохраняются: это не независимая
пользовательская команда обновления child.

За пределами покрытия: CASCADE/SET DEFAULT/RESTRICT с существующими ссылками,
composite/non-id parent keys, self-reference, чужие/неподдерживаемые child metadata,
непустые parent FILES, дополнительные изменения от triggers и транзитивные FK-эффекты.
Для последнего проверяются incoming FK child по именно изменяемым columns после
блокировки child; существующие ссылки отказываются. Связи с неизменяемым child.id
и пустые referencing tables допускаются. Отказ консервативен, если будущий DELETE
trigger затем пропустил бы родителя.

19 новых PG cases: штатные и архивные children, несколько FK/родителей, partial
nulling, audit rollback, action/metadata границы, trigger изменения, caught poison,
skipped parent, update aggregation, оба порядка reparent race, actual lost ACK и
реальный транзитивный composite ON UPDATE CASCADE. Public DESTROY/MERGE не включены.
Демо/образ не менялись; внешних сообщений и GitHub Actions нет.

954 tests/32 suites PASS (185.638s); 86 targeted/3 suites PASS. 19 новых PostgreSQL cases. 26 guards PASS; 10 migration checksums неизменны. Types 343/345 roots, 189/189 прежних диагностик, 0 новых/changed-code. 5 local/remote source hashes совпадают.
