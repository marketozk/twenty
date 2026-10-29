# LOG135 review

## Границы и actual effects

Прямой binding выбранного account или channel запрещает операцию. Зарезервированный
provider app без applicationId/connectionProviderId также запрещён; зарегистрированные
app providers сохраняют допуск существующих native guards. Derived ownership
проверяется по каждой association/junction: смешанная выборка сохраняет защищённые
строки. Более строгие expectedRun/group/folder eligibility не заменены этим owner.

Account блокируется до channel; mapping проверяется после блокировок и повторно
перед commit. Exact metadata/table locks, обязательный association→junction CASCADE,
actual RETURNING и полные retained snapshots исключают непокрытые эффекты.
Null messageId не создаёт вымышленных Message/Thread кандидатов; посторонние orphan
records не попадают в выборку. Один context использует существующие Message,
Participant, target reconciliation и empty-thread stages.

## Исправлено независимым ревью

Пропущенная DELETE-trigger association с null Message могла измениться при следующем
Message DELETE, затем удалиться с Thread. Первоначальный приватный actual-cascade
набор исключал её из retained comparison, скрывая изменение исходного снимка.
Теперь все validators предыдущих стадий выполняются перед новыми снимками стадии
Thread и до допуска её actual cascade IDs. Тесты отдельно проверяют подмену
association, подмену junction и допустимый неизменённый каскад.

Наборы actual Association/Junction IDs остаются приватными и формируются только
после проверки фактических эффектов Thread. Публичных callbacks, mutable context
или skip-audit режима нет. Финальные проверки выполняются до flush и после
SET CONSTRAINTS ALL IMMEDIATE.

Повторное независимое чтение не выявило других конкретных блокеров. Source review
не подменяет результаты тестов; результаты исполнения фиксируются отдельно.
Первый typecheck выявил только widened boolean в двух test fixture options;
они исправлены сохранением literal true через as const.

## Следующий контракт

Не выполнять terminal owner внутри folder scope с последующим junction DELETE.
Для такого вызова нужен общий закрытый owner и exclusive lock с начала транзакции.
После отправки письма ошибка cleanup не должна приводить к повторной отправке.
Политики group sender, blocklist handle/account и свежесть draft caller требуют
проверки в своих точках входа. В этом срезе они не объявлены принятыми.
