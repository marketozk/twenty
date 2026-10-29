# Next — targeted cleanup callers

Подключить MessagingMessageCleanerService и реальные точки вызова к проверенному
closed owner. Захватить server identity и inputs до awaits; использовать strict/
exclusive scope с начала транзакции и сохранить stale expectedRun/group refusals.
Проверять соответствующие policy proofs после последней записи/flush без произвольных
внешних callback-валидаторов.

Group deletion требует locked FROM sender classification, а не только ранее
прочитанных external IDs. Folder deletion требует closed page composition,
включающей оставшиеся junction-only effects после очистки associations, и проверки
folder action/mapping. Фактический count не должен равняться числу запрошенных IDs.
Draft cleanup должен сохранять request attribution и fresh owner checks; сбой после
подтверждённой provider send не является поводом повторять send.

Blocklist имеет отдельный direct association DELETE до общего orphan sweep;
подключённый LOG134 sweep не делает этот первый DELETE аудируемым. Нужны exact
handle/account policy и его собственный закрытый selection boundary.

Остаток ROB765 — [единая таблица приёмки](../rob765-progress.md). Полного аудита,
выката и HTTP/JWT приёмки этот внутренний owner не доказывает.
