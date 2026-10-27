# LOG-025 — хранение запусков, событий и общих лимитов

Продолжение ROB-764. Добавлены восемь core entities: OmniRootExecution,
OmniRootBudgetCharge, OmniEventDispatchPlan, OmniReplyBudget, OmniReplySlot,
OmniRouteActivation, OmniAutomationAdmission и OmniConsumerReceipt.
Это схема хранения: runtime writers, обработчики, API и отправка ещё не готовы.

## Контракты

- Root фиксирует исходное событие, контекст и версию политики. DispatchPlan и
  ReplyBudget имеют составной FK к той же захваченной политике root.
- Budget существует отдельно от slots: нулевая квота сохраняется без команд.
  Slot всегда связан с Command; общая уникальность не зависит от producer.
  Один Command может занимать slots нескольких covered roots.
- Charge дедуплицируется стабильным ключом. CRM no-op допускает cost=0,
  hop требует cost=1; счётчики root не могут превышать сохранённые пределы.
- ConsumerReceipt дедуплицируется по event/consumer, без pinned version в ключе.
  Сохраняет execution ID, версию, попытки и fencing lease для будущего worker.
- Admission связывает MessageLink, activation и Event в том же workspace,
  binding и диалоге. Смена activationVersion не создаёт повторный бизнес-эффект.

Нормативный каталог [spec §3](../../plan/implementation-spec.md#3-схема--rob-764)
уточнён по физическому хранению: budget и slots разделены; conversationId в
Admission — структурная связь для FK. Семантика общей квоты не изменена.
State/producer/rootKind без полного каталога в контракте остаются непустыми text,
а не произвольными придуманными enum. Bigint читаются как string.

В DomainEvent добавлены tenant FK rootExecutionId и составной UNIQUE с
conversationId. Старые NULL roots сохраняются. Существующая ссылка на
несуществующий root вызывает отказ всей новой миграции; данные не исправляются
и не удаляются автоматически. Это проверено с rollback DDL и ledger prefix 3.

## Миграция и проверки

Штатный генератор создал `omni-1793095884267-event-governance` после пустого
baseline. Все 64 SQL-вызова up/down перенесены без изменения. Три прежних
migration source/checksum сохранены. Snapshot DomainEvent выбирается строго по
подтверждённому prefix; остальные старые таблицы проверяются как прежде.

- [135 PostgreSQL tests](pg-tests.txt): 22 новых сценария, заполненный prefix 3,
  replay, empty down/up, orphan-root rollback, tenant/policy/conversation FK,
  квота 0, producer collision, multi-root Command, charge dedup/cost,
  activation/admission dedup, leases и bigint выше JS safe integer.
- [20 dependency guard tests](guard-tests.txt) и [5 checksum tests](checksum-tests.txt):
  всего **160 тестов**. [Полный граф](dependency-guard.json) не содержит новых
  Enterprise зависимостей; это не доказательство отсутствия старого runtime долга.
- [Focused strict typecheck](typecheck.txt): 60 файлов с импортами, PASS.
- [Native schema up/down/up](native-schema-verification.json): после down
  восстановлены прежние 17 таблиц; после up остальные 16 не изменены.
  Все 256 строк штатной истории миграций сохранены.
- [Зарегистрированные upgrade/replay/readiness](registered-upgrade.json) прошли;
  финальный штатный generator diff пустой.
- Независимое адресное ревью entities и FK — PASS, подтверждённых blocker/major
  нет. Дополнительно проверены registry/snapshot и тесты. Claude Code и новый
  полный архитектурный круг в этой порции не запускались.

Проверки выполнены на временных PostgreSQL17/Redis в ограниченных containers
без внешних портов. Использован image LOG-022 с focused SWC compilation;
новый полный image и полный server typecheck не выполнялись.
[Хеши исходников](source-snapshot.json) · [Сводка](verification.json).

[Cleanup](cleanup.json): собственные containers, exclusive volumes и сеть
удалены после проверки принадлежности; БД уничтожены вместе с tmpfs.
Неактивные source/tool caches сохранены. Builder не запускался, образ,
start timestamps и health действующего демо не изменились.

## Что ещё предстоит

Ограничения схемы не заменяют транзакционные writers. Ещё нужны атомарные
root/event/initial plans/receipts, проверка initialEventIds и immutable targets,
общая квота по covered roots с Command, charge/counter accounting, источник
доверенной позиции и монотонная граница activation, полномочия и lifecycle.
`update:false` защищает ORM-путь, а не запрещает прямой SQL UPDATE.
Будущие RunIntent/Reference и dynamic workspace ссылки не получили фиктивных FK.

Следующая порция — ingress persistence: canonical envelope/hash, generation,
durable receipt/ACK и конфликт ключа с другим payload. Затем — атомарное
Message+audit+event, inbox/outbox/recovery и email regression. ROB-764 In Progress.
Down проверен на пустых новых таблицах; он не является автоматическим откатом
живой системы с данными. Каналы SaleBot и действующее демо не менялись.

## Публикация

Код `4cc66d8900d673994dae701e0fbfbc6c5f39615d` отправлен в текущую ветку.
[Отчёт ROB-764](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-f111f44a).
Описание и единственный комментарий прочитаны обратно; статусы 11 задач сохранены.
GitHub CI нового коммита не начал выполнение из-за billing block аккаунта;
подтверждено аннотациями обоих jobs. Облачный CI pass не заявлен.
[Метаданные публикации и сверки](publication.json).
