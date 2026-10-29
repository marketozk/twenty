# LOG139 — проверка удаления orphan CalendarEvent

Изучены CalendarEventCleanerService и его production call sites, четыре standard
FK definition, issued native cleanup scope, native snapshot/audit helpers и
assertNoReferentialUpdateEffects. Подготовленный owner независимо прочитан вторым
агентом; конкретных блокеров в заявленной пяти-табличной границе не обнаружено.
Независимое чтение не заменяет runtime проверки.

## Контракт

Закрытый terminal owner принимает до 500 candidate UUID. SYSTEM authority,
strict/exclusive scope, active workspace и пять точных standard metadata обязательны.
Копируются IDs и actor до первого ожидания. Существующие Event блокируются раньше
дочерних строк; после ожидания блокировки дочерняя связь читается заново.
DDL fence и наличие всех четырёх ожидаемых FK проверяются даже без дочерних строк.

Живая Association защищает Event. Tombstoned Association не защищает его и
каскадно удаляется с аудитом. Явно переданный tombstoned Event допустим — это
контракт прежнего адресного helper, не будущего global sweep с live-only discovery.
Participant attendance и manual Target не меняют прежнее решение об orphanhood.

DELETE RETURNING определяет фактические удаления Event, Association, Participant,
Target и SET NULL у CallRecording. Пропущенные триггером корни и весь их граф
остаются без изменений и без выдуманных записей аудита. CallRecording сохраняет
все поля, включая FILES, точность JSON и timestamp, кроме calendarEventId.
Отдельный guard запрещает неучтённые косвенные UPDATE effects от FK SET NULL.

Полные DB-text snapshots сравниваются до audit flush и после выполнения
отложенных constraints. Исходные IDs остаются в перечитываемом диапазоне, чтобы
поздний reparent или NULL не скрывал изменённую строку. Populated неизвестные
mutating FK effects отклоняются. Ошибка возвращается владельцу транзакции.

## Проверки и ограничения

30 новых PostgreSQL cases проверяют actual effects, redaction, mixed RETURNING,
запрет неподходящего scope, missing FK, unsupported cascade, composite ON UPDATE,
BEFORE-trigger key rewrite, late audit/deferred changes, rollback и реальную потерю
COMMIT ACK. Шесть двухсоединительных случаев наблюдают ожидание PostgreSQL Lock
при INSERT/reparent Association и CallRecording в обоих порядках.

Первый typecheck выявил один test-only конфликт string с UUID template literal
в Array.includes. Сравнение заменено на some(id => id === resourceId) без изменения
условия проверки; окончательная регрессия включает эту правку. Итог: 2130 тестов
в 71 наборе прошли, новых и changed-file ошибок типов нет.

Owner пока не подключён к production callers. Не заявляются аудит global sweep,
provider sync, произвольных trigger writes вне наблюдаемого графа или надёжная
доставка postcommit событий. Последующая композиция должна использовать private
stage и одну финальную проверку/flush, а не вкладывать terminal owner в другие writes.
