# Ревью R11: конечные таблицы `decision-tables.md`, верификатор и `model-result.json`

**Вердикт: `bounded_tables_needs_revision`.** Блокирующих дефектов три, все небольшие. Ещё один дефект оракула серьёзный, но не блокирует.

Сам по себе этот результат **не означает** готовности всего проекта к реализации (`ready_for_implementation`). Проверка ограничена событиями, отменой, правами и жизненным циклом Command. Даже после исправлений нужен отдельный полный проход по всему проекту.

## Что проверено

- **Документы целиком:** `plan/decision-tables.md`, `plan/verification/check_decisions.py`, `plan/verification/model-result.json`.
- **Spec:** §3 (сущности, строки 44–57), машина состояний Command (78–91), строка 155, §15.3 (283), §15.9 (367), §15.14–15.15 (419–438), §15.19–15.23 (485–545).
- **`design/06-api.md`:** строки 55–79. **`design/09-automation-contract.md`:** строки 55–133.
- **Upstream-код:**
  - `workspace-event-emitter.ts:42-71` и `workspace-event-batch.type.ts:3-8`: ссылки на отдельную запись в batch нет, утверждение таблицы верно.
  - `workspace-data-source.ts:77-136`: события отправляются через `afterCommit`, который живёт только в памяти процесса.
  - `workflow-database-event-trigger.listener.ts`: `getDatabaseEventListeners:440-462` читает кэш; в `:428-429` передаётся `legacyWorkflowId ?? workflowId`, то есть legacy ID реально доходит до входной границы.
  - `workflow-trigger.job.ts:78-96`: `findCoreWorkflowByIdOrWorkspaceWorkflowId` уже даёт сопоставление legacy→core; неактивная версия молча отбрасывается (`ACTIVE` gate).
  - `common-merge-many-query-runner.service.ts:375-429`: `relatedRepository.runMutation` идёт через тот же `transactionScope`.
  - Утверждения таблицы об upstream подтверждаются. Новые omni guards в коде отсутствуют, как и заявлено.
- **Скрипт я не запускал** (shell запрещён). Числа в `model-result.json` сверил вручную по коду: 6+6+768+14+40=834, количество пойманных мутантов совпадает.
- **Раскрытие:** выдача Grep по всему каталогу случайно показала несколько строк из `cross-review/*` и одну строку из `STATUS.md`. Сами файлы я не открывал, на выводы это не повлияло.

## Блокирующие дефекты

**B1. Оракул требует `ResourceScope` от человека, а контракт этого не требует.**
- **Где:** `check_decisions.py:73-74` и `:138` применяют `scope` ко всем отправителям.
- **Что сказано в контракте:** таблица `:71` требует ResourceScope/edges только «для non-human»; spec `:436` для принятой human Command проверяет права, маршрут, generation и manager policy. Свидетель мутанта `ignore_scope_edges` в `model-result.json:96-112` сам является human-кейсом: 8 из 15 пойманных случаев человеческие.
- **Сценарий:** P04, перепривязка identity A→B. Человек с действующими правами получает отказ, а модель называет это правильным поведением.
- **Исправление:** проверять `not scope` только для `sender != 'human'`. При желании добавить отдельный guard `binding` для всех отправителей. Добавить мутант `human_requires_captured_scope`.

**B2. Явная деактивация workflow не останавливает уже созданную Command на границе dispatch.**
- **Где:** таблица `:34`, `:46` и 09 `:120` применяют `cancellationEpoch` к start/resume/effect и governed job. В условиях отправки (таблица `:71`), в C03 и в `dispatch()` проверки `cancellationEpoch` нет. В P-таблице нет строки «deactivate/delete workflow». Для takeover аналог есть (spec `:432`), для деактивации нет.
- **Сценарий:** governed v1 создаёт pending Command и занимает слот. Администратор явно деактивирует workflow, `cancellationEpoch` растёт. Dispatch проверяет права, маршрут, scope и `automationEpoch`: всё совпадает, потому что деактивация не меняет `automationEpoch`. Сообщение клиенту уходит после явной отмены.
- **Исправление:** добавить строку P13: deactivate/delete под policy UPDATE, `cancellationEpoch++`, атомарно отменить pending non-human Commands этого `coreWorkflowId`, для dispatching/accepted/outcome_unknown записать durable `cancelRequested`. Либо хранить `capturedCancellationEpoch` в Command и сверять его в C03 и при recovery. Добавить guard в таблицу `:71` и мутант в модель.

**B3. В `06-api.md` нет операции отмены, на которой держатся C10/C11.**
- **Где:** `06-api.md:56` перечисляет минимальные операции: `enqueue`, `commandStatus`, `accountStatus`, `pauseAccount`. `cancelCommand` → `cancelled`/`too_late` с tombstone есть только в spec `:283`.
- **Почему это важно:** право отмены реализуемо без выдуманного upstream API, потому что это новый контракт коннектора. Но API-документ ему противоречит, а таблица `:3` требует при противоречии исправлять оба документа.
- **Исправление:** дописать в `06-api.md:56` `cancelCommand(commandId)` → `cancelled|too_late` с tombstone и сверкой journal перед вызовом провайдера, со ссылкой на spec §15.3.

## Серьёзный, но не блокирующий дефект

**M1. Запоздавший ACK после локальной отмены или отказа до приёма принимается молча.**
- **Где:** `check_decisions.py:90-93`, `:160-166`: состояния `cancelled`/`failed` плюс `ack` дают `none`.
- **Сценарий:** C09, локальная pending отменена при условии «remote enqueue не мог начаться», затем приходит авторитетный ACK по тому же commandId. Это прямое нарушение инварианта C09, и по C16 (`:84`, `:103`) оно требует reconciliation. Для failed в варианте C07 (отказ до приёма) то же самое.
- **Исправление:** различать терминальное происхождение: `cancelled_local` против `cancelled_remote`, `failed_pre_accept` против `failed_terminal`. Для ACK на локальных и pre-accept состояниях ожидать `reconcile`.

## Несущественные замечания и улучшения

1. **Гейт `setMode(auto)` проверяется тавтологично.** `:144-151`: ожидаемое значение и вычисление совпадают, мутанты меняют сам harness. Лучше выделить функцию `can_set_auto(commands)` и проверять наборы из нескольких Command.
2. **Неполное покрытие состояний и фикстур.**
   - Не проверены pending+timeout, pending+reject_proof, pending+cancel_proof.
   - Ветка `'native'` в `snapshot_dispatch` недостижима: нет фикстуры со смешанными governed и ordinary targets.
   - Повтор по C07 в модели схлопнут в `failed`.
   - Переход outcome_unknown+ACK→accepted есть в модели и в spec `:85`, но отсутствует в C04.
3. **Зависание в outcome_unknown.** Человеческая Command в этом состоянии может блокировать `auto` бессрочно: spec `:85` разрешает остаться unknown, `:543` требует reconcile. Нужна либо явная аудируемая операция «оператор разобрал исход», либо прямая фиксация, что блок намеренный.
4. **Не определено, когда считается filter-miss.** Строка «G|O|empty» его включает, но не сказано, где вычисляется фильтр: при commit (сейчас upstream обогащает связи уже в listener с bypass) или при старте по фильтру pinned-версии.
5. **Нет строки для crash между COMMIT и `afterCommit`** (upstream `workspace-data-source.ts:128`). Сценарий покрыт recovery scanner в spec `:493`, достаточно перекрёстной ссылки в разделе E.
6. **Строка O→G.** Событие ordinary-workflow не исполняется вообще. Стоит явно назвать видимый исход (empty/gap), чтобы это не выглядело тихой потерей.
7. **Порядок строк.** P12 стоит перед P11 (`:64-65`).

Остальное согласовано между таблицей, spec, 06-api и 09: E01–E14 с матрицей корней 09 `:69-81`, P01–P12 с §15.15/15.22/15.23, порядок блокировок `:67` с §15.9, C01–C18 с машиной состояний spec `:80-91` и строками `:543-545`. Противоречий, кроме перечисленных, не нашёл.

## Чего этот верификатор не доказывает

- сериализацию SQL и блокировок, отсутствие deadlock;
- межпроцессный fencing коннектора и userbot journal;
- полноту writers и producers (EventCoverageRegistry, P09);
- уникальность Message, конфликты hash, Attachment XOR, бюджеты и burst-наборы;
- строки E01–E14, P01–P12 и C01–C18 за пределами 12 комбинаций отправителя и режима, мутанта legacy alias и 40 переходов;
- поведение на этапе admission (`takeover_on_send`), реальный порядок, подписи и версии ACK, межтенантное сопоставление ID.

Мутанты встроены в те же функции, что и guards. Они показывают, что каждый guard заметен на фикстурах, но не являются независимым доказательством поведения.
