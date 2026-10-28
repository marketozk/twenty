# LOG094 — независимое read-only review

Проверены четыре GraphQL/REST UPDATE caller, CommonBase/UpdateOne/UpdateMany,
transaction owner и WeakMap proof, nested repository executor/permissions,
postcommit getter/visibility/hook lifecycle и actor-specific PostgreSQL fixture.

Подтверждённых блокеров reviewer не нашёл. Существующие публичные callers не передают
legacy scopes; merge вызывает kernels отдельно. Предложенные acceptance cases
lost COMMIT ACK, mismatched actor/workspace и expired scope добавлены и прошли.

Отдельный разбор упавшего connect test подтвердил ошибку fixture input:
ConnectObject/hasRelationConnect требуют `connect.where`. Исправлен тест;
production contract не менялся. Reviewer не редактировал файлы и не запускал тесты.

Следующий CREATE участок исследован: insert/save/upsert используют runInsert;
FILES требует same-executor store и устойчивых parent IDs до enrich; actual inserted
IDs должны исключать конфликтующие skipped rows. Public nested custom creates и
shareWith ограничивают возможность раннего включения owner. Это план следующей
реализации, а не подтверждение готовности CREATE.
