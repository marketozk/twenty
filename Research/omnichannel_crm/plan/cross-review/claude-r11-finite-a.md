# Ревью R11-A: таблицы решений и конечный оракул

**Вердикт: `bounded_tables_needs_revision`.** Нашёл три блокирующих дефекта контракта, все в публикации и кандидатах native listener. Каждый закрывается одной-двумя строками в таблице и spec. Таблицы P (policy) и C (Command), матрица отправитель × режим и правила close/reopen в остальном согласованы с spec и 09.

Этот результат **не даёт** `ready_for_implementation` для всего проекта. Область проверки ограничена: таблицы, модель и прямые ссылки на spec и 09. Полную проверку проекта я не делал.

## Что проверено

- **План:** весь `decision-tables.md`, `verification/check_decisions.py`, `model-result.json`, манифест R11-A.
- **spec:** §4 (outbound и таблица состояний, стр. 76–89), §5, §15.3, §15.11, §15.14, §15.15, §15.19, §15.21–15.23.
- **Документы design:** `06-api.md:19,77` и `09-automation-contract.md` целиком.
- **Upstream:**
  - `workspace-event-batch.type.ts`, `workspace-event-emitter.ts` (`emitDatabaseBatchEvent`);
  - `workflow-database-event-trigger.listener.ts` (`getDatabaseEventListeners`, `handleEvent`, `enrichRecordsWithRelations`);
  - `workflow-trigger.job.ts:94` (проверка ACTIVE);
  - `workflow-automated-trigger-maps.type.ts`;
  - `common-merge-many-query-runner.service.ts:353–521`.
- **Пересчёт вручную:** счётчики модели (6 + 768 + 7 + 36 = 817) и число поймавших срабатываний каждого негативного контроля (15, 7, 3, 3, 1, 1, 1) совпадают с кодом.
- **Хэши манифеста** я не проверял: shell запрещён.

## Блокирующие дефекты

**B1. Не определён канонический идентификатор workflow.** Касается `decision-tables.md:30–41`, E13 и `09:53,124`.
- В upstream у trigger две пары идентификаторов: `workflowId` и `legacyWorkflowId`, `coreWorkflowVersionId` и `workspaceWorkflowVersionId` (`workflow-automated-trigger-maps.type.ts:4–13`).
- Listener ставит в очередь `legacyWorkflowId ?? workflowId` (`listener.ts:428–429`), а job принимает любой из двух через `findCoreWorkflowByIdOrWorkspaceWorkflowId` (`workflow-trigger.job.ts:78–82`).
- В плане `consumerId = omni-workflow:{workflowId}`, `runId = UUIDv5(...,workflowId)`, а listener должен исключать workflowId, найденный в плане. Какой из двух ID имеется в виду, не сказано.
- **Сценарий:** план хранит core ID, listener сравнивает legacy ID. Исключение не срабатывает, и в строках G→O/G→G получаются native enqueue плюс governed запуск. Это двойное исполнение, которое таблица прямо запрещает.
- **Минимальное исправление:** зафиксировать core workflow ID и core version ID как канонические. Legacy ID нормализовать до сравнения, ключей идемпотентности и UUIDv5. Добавить негативный контроль «legacy ID в исключении».

**B2. Нет правила для события без ссылки на snapshot.** Касается E12 (`:24`) и строки G→O (`:36`).
- E12 покрывает только «мигрированный путь».
- **Сценарий:** producer без ссылки (не мигрированный путь) создаёт событие для eventName, у которого есть governed подписка. Тогда при commit план не сохранился, а при текущем каталоге O listener по cache запустит ordinary v2. Это нарушает «нет: workflow был governed при commit».
- Не сказано и другое: обязательна ли ссылка для каждого record event мигрированного пути, даже если каталог при commit пуст. Без этого «законно не записано» нельзя отличить от «потеряно».
- **Минимальное исправление:**
  - ссылка обязательна для каждого record event объекта или события, на которое когда-либо была governed подписка;
  - активация governed подписки отклоняется, пока не мигрированы все producers этого объекта и события (по аналогии с P09);
  - отсутствие ссылки при наличии governed истории в окне означает gap или deny.

**B3. Не определено, по какому признаку отменяется pinned governed intent.** Касается `:30` и строк G→O (`:36`, `:38`).
- «Explicit deactivation отменяет, archive при публикации нет». В upstream после публикации v2 версия v1 становится ARCHIVED, деактивация меняет статус активной версии.
- **Сценарий:** G v1 → публикация ordinary v2 → деактивация v2 до старта intent v1. Если проверять статус версии v1, деактивация не обнаружится никогда. Если проверять ACTIVE, archive ошибочно отменит intent.
- **Минимальное исправление:** признак отмены задаётся на уровне workflow: durable `OmniWorkflowSubscription.enabled` или lifecycle event под тем же fence, а не `CoreWorkflowVersionStatus`. Добавить в матрицу колонку или строку «deactivated до listener/start → cancelled + audit».

## Неблокирующие замечания

1. **Captured scope у человека.** `:63` требует «неизменный captured scope» во всех строках, включая человеческую. Spec §15.15 для принятой human Command перечисляет только права автора, route, generation и manager policy. Модель требует scope для human: свидетель `ignore_scope_edges` как раз human. Нужно выбрать одну формулировку. Возможный вариант: для human это текущий identity binding (P04), а не captured scope LLM.
2. **Смена статуса без закрытия.** В таблице P нет строки «смена статуса без закрытия → только controlEpoch++», хотя spec §15.15 и §15.19 это задают.
3. **Переходы в модели шире таблицы C.** Модель разрешает `dispatching + sent_proof → sent` и `dispatching + reject_proof → failed`. В таблице C06 источник только accepted/unknown, а C07 допускает ещё bounded retry. Нужно либо добавить такие строки (эхо раньше ACK, C13), либо сузить модель.

## Насколько модель соответствует контракту

Чтобы `:113` не обещал больше, чем модель проверяет, стоит сузить формулировку или дополнить модель.

- **Publish.** Цель моделируется булевым значением, поэтому подмену pinned v1 текущей версией (E13, T14-A) модель поймать не может. Она не моделирует деактивацию (B3) и двойную идентичность (B1). Из 6 строк проверено 6, недостижимые комбинации отброшены. Негативный контроль один.
- **Dispatch.** Независимый эталон здесь только `SEND_EXPECTED`. `denied_by_invariant` повторяет охранные условия самой `dispatch`, то есть тавтологичен. Негативные контроли есть только для scope и epoch. Для closed, rights, route, шаблона G17, «AI в assist отправляет» и «human сравнивает epoch» их нет, хотя эталон поймал бы все эти мутации. Флаг `epoch` объединяет automationEpoch и invalidating control event.
- **Human mode gate.** Это по сути вручную заданная таблица. Измерения `cancelRequested` нет, а `:72` и `06-api:77` требуют его явно.
- **Lifecycle.**
  - Нет состояния `pending`. Поэтому не проверено ключевое разделение права отмены C09 (локальная атомарная отмена) и C10 (cancelRequested). Сейчас `transition('pending','cancel_request')` вернул бы pending, что противоречит C09.
  - Для терминальных состояний противоречивое доказательство молча оставляет состояние. Комментарий в `check_decisions.py:116` говорит о reconciliation, но выхода reconciliation в модели нет, поэтому мутацию «тихо проигнорировать» отличить нельзя (C16).
  - Не моделируются C02 (конфликт hash), C06 (ровно один Message) и C14 (Attachment XOR).

## Что этот верификатор не доказывает

Реальную атомарность транзакций, порядок блокировок и отсутствие deadlock, межпроцессный fencing коннектора и userbot journal (что честно отмечено в `:99`), полноту writers и producers (см. B2), timing и поведение Redis. Хэши манифеста тоже им не проверяются. Это задача T-тестов.

## Реализуемость границ без выдуманного upstream API

- **Транзакции.** Admission, plan, intents и budget в одном commit реализуемы через существующие `WorkspaceTransactionScope` и `getRepository`; merge runner показывает, что так уже делается. `afterCommit` только ускоряет постановку в очередь.
- **Что потребует новых внутренних контрактов,** и документ это признаёт: ссылка на каждый record event в `WorkspaceEventBatch` (сейчас там только `{name, workspaceId, objectMetadata, events}`), обход ACTIVE gate для pinned job и `OmniWorkflowSubscription`.
- **Право отмены** (`cancelCommand`, tombstone, journal) относится к новому коннектору, а не к Twenty upstream. Выдуманного API Twenty здесь нет, но и доказательства тоже, пока не пройдут T11/T28.

## Итог

`bounded_tables_needs_revision`: исправить B1–B3 в таблице и spec/09 вместе. Желательно добавить в модель `pending` и `cancelRequested`, выход reconciliation и недостающие негативные контроли, либо сузить формулировку в `:113`. Готовность всего проекта к реализации из этого результата не следует.
