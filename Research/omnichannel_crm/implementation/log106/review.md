# LOG106 — источник и ревью

Person.company и Opportunity.company/pointOfContact имеют штатный SET_NULL в
compute-person/opportunity-standard-flat-field-metadata. CommonDestroy вызывает
native delete; его nested reader пока не получает scoped repository. MERGE имеет
свой owner и произвольные related writes, поэтому публичные пути ещё не включены.

Переиспользуются native snapshots/recordNativeCrmUpdates, transaction owner и
реальный pg_constraint helper. Child locks/readback не заменяют родительский
predicate, а audit/events используют actual parent RETURNING.

Read-only reviewer нашёл транзитивный FK-пробел: composite UNIQUE person(id,companyId)
и grandchild FOREIGN KEY(personId,companyId) ON UPDATE CASCADE меняли третий уровень
без audit. Regression воспроизвёл ошибку до исправления: delete успешно завершался,
хотя ожидался отказ; остальные 16 cases прошли. Отдельная rollback-проба подтверждает
реальное действие PostgreSQL. [Прогон до исправления](transitive-before.log).

Исправлено: после child FOR UPDATE проверяются существующие incoming references
к меняющимся columns. Default helper callers по-прежнему проверяют все FK. Добавлены
положительные случаи неизменяемого child.id и пустой таблицы. Повторное read-only
ревью не выявило новых блокеров; reviewer не запускал тесты и не правил файлы.
