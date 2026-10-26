**B-3 закрыт.** Но вторая заявленная правка, в `design/04-testing.md`, не внесена.

**B-3: `design/02-behavior.md:68`.** Старого ключа `(workspaceId, bindingId, messageLinkId, effectKind, activationVersion)` в файле больше нет: поиск по `activationVersion` и «уникальный ключ допуска» находит только новую строку 68. Абзац теперь ссылается на схему §3 и поток §5 спецификации. Обе ссылки ведут на существующие разделы `implementation-spec.md` («3. Схема — ROB-764» и «5. Durable events и import/live»). Требование «одна canonical Message и не более одного automatic customer admission при смене activationVersion» совпадает с владельцем (`implementation-spec.md:57, 118`).

**`design/04-testing.md:23`.** Слово «cursor» на месте: строка по-прежнему заканчивается фразой «UI требует подтверждения с новым cursor». observedReplyRevision в этой строке был и раньше, его вставили при закрытии B-2. С владельцем это не противоречит, на B-3 не влияет и реализацию не блокирует. Если нужна чистая формулировка, замените «с новым cursor» на «с новым observedReplyRevision».

Других остатков по B-1…B-4 и N-6 нет. Будущие тесты не пройдены, ворота G01–G20 остаются воротами активации.
