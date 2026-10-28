# LOG095 — read-only review

Независимо проверены runInsert/performInsert, save/upsert, create snapshot helper,
descriptor и PostgreSQL tests. Блокеров не найдено: captured input и poisoning стоят
до await, actual RETURNING IDs не зависят от caller selection, default/trigger File
attachments не обходят bounded coverage, create/update action keys разделены.

Reviewer указал границу mixed rollback test: неизвестный Company.companyId проверяет
validation failure, а не FK. Добавлен отдельный тест Person.companyId с настоящим
нарушением FK и откатом предшествующего update. Добавлены save/upsert input capture
до lookup и poisoning при перехваченном nested relation validation error.

Публичный CREATE не включён. Reviewer не менял файлы и не запускал тесты.
Следующий FilesFieldSync участок разобран отдельно: create-mode может применять
изменения только к actual written parents, update-mode должен остаться строгим;
нужны проверки всех FILES columns после core update. Lock inversion на конфликтующей
вставке требует атомарного rollback, нельзя обещать deadlock-free поведение.
