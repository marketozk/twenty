# LOG096 — native CREATE с файловыми вложениями

ROB765 In Progress. Внутренний nativeAudit owner создаёт стандартные
Company/Person/Opportunity вместе с core File в одном executor. UUID родителя
выделяется до enrichment только при наличии вложений; вход caller не меняется,
explicit null ID остаётся ошибкой. UUID parent/File нормализуются, неоднозначный
parent или повторное использование File в одном batch отклоняются.

File store заранее блокирует и проверяет все переданные файлы. После INSERT
только фактически вставленные parents переводят File из temporary в постоянное
состояние и получают crmFile/update + crmRecord/create. Полностью и частично
пропущенные строки не дают фиктивного аудита. После всех writes readback проверяет
все planned File rows: пропущенные должны остаться полностью неизменными.
Снимок полной строки используется только для сравнения в памяти, в журнал не пишется.

Сверяются фактические ссылки каждого FILES поля родителя, включая null, [] и
отсутствующие поля. Trigger/default не может незаметно добавить вложение или
подменить родителя. Ошибка core File, audit или общей операции откатывает всё.
Unknown COMMIT остаётся unknown, повтор отправки SQL не выполняется.

## Проверка

744 tests / 27 suites PASS, 163.068 s; 28 новых PG tests, 98 targeted.
26 guard tests PASS, десять migration checksums неизменны, dependency baseline PASS.
Types 334/334 roots, 189/189 baseline diagnostics, 0 новых/changed. Пять LF source
hashes совпадают между локальными файлами и проверенным стендом. Первый typecheck
обнаружил ошибки аннотаций captured record и тестовых данных; исправлены, typecheck
и общий regression повторены на финальном коде.

- Целевые PostgreSQL сценарии: generated/explicit IDs и все три объекта, caller
  immutability, mixed/all skipped, ambiguous owners, concurrent File claim,
  mixed save/upsert, null/empty/omitted fields, реальные триггеры и fault injection.
- Независимый reviewer нашёл отсутствие проверки skipped File после trigger и
  изменение смысла explicit null ID. Оба замечания исправлены, добавлены регрессии.
- Первичный тест omitted FILES использовал полностью пустую запись, которая
  отклоняется прежним INSERT builder. Исправлен тест: передаётся id без FILES.
- Итоговые числа и воспроизводимые выводы: [results](results.json),
  [targeted](target.log), [regression](regression.log), [types](typecheck-differential.json),
  [source hashes](source-snapshot.json), [review](review.md).

## Границы

Public CREATE ещё не подключён. Общий CRUD/merge, metadata/role/session owners,
negative audit и health остаются в ROB765. Whole-server typecheck имеет известные
baseline diagnostics; отсутствие новых ошибок не означает чистый полный build.
Новый образ и production rollout не выполнялись. GitHub Actions не использовался.

Update блокирует parent перед File, create — File перед INSERT. Конкурентный
конфликт может завершиться PostgreSQL deadlock rollback; автоматического retry
нет и отсутствие deadlock не заявляется. Транспорт и пользовательские данные
не использовались. Следом — public CREATE/nested/shareWith/upsert compatibility.
