# Сверка этапа B (R16): замечания F1–F10, Self1–4, Editorial1 и все 66 корней

## Вердикт: `needs_revision`

Мой этап A сохранён без изменений; это только сверка.

Все 17 проявлений R16 закрыты по существу. Но правки породили регрессии:
- **1 Medium:** публикация политики автоматизации обновляет все диалоги binding в одной транзакции под эксклюзивной блокировкой workspace;
- **4 Low:** противоречие в порядке блокировок, неопределённое начисление hops на первичные цели, редакционные поломки таблицы схемы и индекса владельцев, «осиротевшая» колонка `Conversation.revision`.

Перестройки архитектуры не требуется. ROB-764 затронут только редакционно (таблица §3) и через F7b. Medium и Low по блокировкам/бюджету касаются ROB-769.

Тесты не запускались, gates не выбирались, runtime-проверка не заявляется.

---

## 1. Статус каждого проявления R16

| Проявление | Где проверено | Статус |
|---|---|---|
| **F1** версии политики автоматизации | `implementation-spec.md:46-47, 97, 99`; `access-control.md:21-27, 39` | **Закрыт.** Неизменяемые версии, FK `(workspaceId, policyId, policyVersion)`, публикация с CAS, аудитом и receipt, без повтора при no-op. **Порождённая регрессия → N-15 (Medium, ниже)** |
| **F2** общий бюджет эффектов и hops на корень | `implementation-spec.md:61-62`; `workflow-execution.md:141-147` | **Закрыт по сути:** счётчики и `OmniRootBudgetCharge`, атомарно по всему covered set, стабильный ключ, без повторного расхода при retry, сверка unknown commit. **Остатки → N-6, M-13 (Low)** |
| **F3a** CAS и идемпотентность административных команд | `implementation-spec.md:45, 50, 81-85, 99`; `access-control.md:41-47` | **Закрыт.** Единый writer, policy UPDATE в начале, receipt в одном commit, replay с текущей авторизацией, tombstone, `result_expired` |
| **F3b** потеря ответа при создании webhook-секрета | `access-control.md:49`; `06-api.md:127` | **Закрыт.** `secret_not_replayed`, явная ротация новым ключом с атомарным отзывом старого |
| **F4** динамический WorkspaceMember | `implementation-spec.md:53, 101` | **Закрыт.** FK только на core Conversation; проверка сервером под fence; lifecycle удаления. Факт по коду подтверждён ранее (`workspace-member.workspace-entity.ts`, `getWorkspaceSchemaName`) |
| **F5** право отмены команды | `sending-ui.md:15`; `implementation-spec.md:330`; `06-api.md:35` | **Закрыт.** Единое правило: автор либо `command.cancel`; системная отмена — отдельный writer; чужой tenant или transport owner — deny. Старой фразы «Caller не может отменить чужую» больше нет (grep пуст) |
| **F6** неполный индекс API | `06-api.md:23-28` | **Закрыт.** Добавлены queue, team, knowledge, custodian, author mapping, purge |
| **F7a** производные состояния receipt | `05-models.md:31` | **Закрыт** (`blocked_config` добавлен) |
| **F7b** счётчик `conversationSequence` | `implementation-spec.md:51, 58, 103` | **Закрыт.** Остаток → N-33 (Low): колонка `Conversation.revision` |
| **F8** шаг CLASSIFY | `workflow-execution.md:71`; `automation-source-matrix.md:80` | **Закрыт.** Явный deny и требование AI provenance |
| **F9** SSE-курсор при смене эпохи | `sending-ui.md:76` | **Закрыт.** Перепроверка без сброса; snapshot-required только при смене restoreIncarnation или реальном gap |
| **F10** principal для assist-черновика | `access-control.md:17`; G04 в `implementation-spec.md:271` | **Закрыт.** Scoped service principal, ACL артефакта при выдаче, внутренние заметки только по G04 |
| **Self1** ранняя disabled v0 (ROB-764) и активация в ROB-769 | `implementation-spec.md:99`; `phase_1:59`; `phase_5:59` | **Закрыт.** Binding и v0 создаются атомарно; нулевые бюджеты; ранние корни не переактивируются при смене head (согласуется с `design-20`). Конфликта с activation boundary нет |
| **Self2** хранилище сопоставления исторических авторов | `implementation-spec.md:54, 445`; `06-api.md:27`; `phase_6:37` | **Закрыт.** Остаток Low → N-33: таблица не включена в список writer'ов revision в `:99` |
| **Self3** хранение receipt | `access-control.md:47` | **Закрыт.** Tombstone хранится до controlled purge, при удалении участника не каскадируется |
| **Self4** FK на версию политики у всех потребителей | `implementation-spec.md:97` | **Закрыт.** Остаток Low → N-33: для human Commands неясно, обязателен ли `policyId/policyVersion` (`:57`) |
| **Editorial1** заголовок реестра | `registry.md:3` | **Закрыт** |

---

## 2. Оставшиеся замечания (исправлять у владельцев)

### R16-B1 — Medium, порождено F1 → корень N-15. Публикация политики обновляет все диалоги binding в одной транзакции
- **Где:** `access-control.md:27`: «Writer берёт policy UPDATE, binding, затем затронутые conversations… повышает policyEpoch и automationEpoch всех диалогов binding».
- **Сценарий:** на binding с десятками тысяч диалогов одна транзакция держит `WorkspacePolicyState FOR UPDATE` и обновляет все строки.
  - Все защищённые чтения workspace (они берут FOR SHARE) ждут и упираются в `query_timeout` пула primary (`workspace-data-source.service.ts:60, 151`; в core по умолчанию 10 с, `core.datasource.ts:81`).
  - Сама публикация может стабильно не укладываться и не проходить.
  - В том числе срочное ужесточение политики (например, выключение авто-режима на маршруте).
- **Почему fanout не нужен:** публикация и так сериализуется с каждым эффектом через policy UPDATE против SHARE. Эффекты уже хранят захваченный `(policyId, version)`.
- **Минимальная правка:** вместо массового повышения automationEpoch ввести правило: non-human effect, dispatch и resume требуют совпадения захваченной версии с `AutomationPolicy.currentVersion`, прочитанной под policy SHARE (binding уже стоит в порядке блокировок). Несовпадение → `cancelled_stale_control` и handoff лениво, при dispatch/scanner. Если fanout оставить, то пакетами после переключения head, как перенос очереди в §15.27. Добавить строку публикации в таблицу P `decision-tables.md`.

### R16-B2 — Low, порождено F2/F3a → корень N-6. Противоречие в порядке блокировок
- **Где:** `workflow-execution.md:143`: строки бюджета корня берутся «в позиции DispatchPlan/ReplyBudget (перед Command/CRM rows)». Но канонический порядок `access-control.md:55` ставит CRM records **до** DispatchPlan/ReplyBudget.
- **Сценарий взаимоблокировки:**
  - транзакция AI-эффекта: корень R, затем запись X;
  - governed-мутация X, которая в той же транзакции создаёт DATABASE_EVENT-цель с hop-расходом: X, затем R.
  - Получаем 40P01. Retry ограничен, так что безопасность не нарушается, но нормативный текст противоречит сам себе.
- **Дополнительно:** в каноническом списке нет `PolicyMutationReceipt` (`:47` его размещает «после policy lock до binding») и строки head `AutomationPolicy`. Это тот же класс дефекта, что B14-1.
- **Правка:** убрать «/CRM» из скобки (стоимость известна после мутации; проверка остатка и откат в той же транзакции работают). Вписать receipt и head политики в канонический список.

### R16-B3 — Low, порождено F2 → корень M-13. Не определено начисление hops на первичные цели плана
- **Где:** `workflow-execution.md:147` («Hop — новый допущенный governed execution… Root admission сам имеет 0 hops») против `design-19:95` (план и все intents фиксируются атомарно при admission).
- **Неясно:**
  - расходуют ли hops агент и workflow-цели самого message-плана;
  - что делать, если целей больше maxHops: частичный план противоречит атомарности.
- **Дополнительно:** §5 `implementation-spec.md:145` всё ещё говорит «лимит даёт видимый paused/error», а владелец — terminal `budget_exhausted` + handoff.
- **Правка:** явно сказать, что первичные цели стоят 0 hops (либо проверять «целей ≤ maxHops» при публикации и делать admission по принципу всё-или-ничего). Привести §5 к владельцу.

### R16-B4 — Low, порождено правками → корень L-2. Редакционные поломки
- **Таблица схемы:** пустые строки в `implementation-spec.md:48` и `:63` разрывают таблицу §3. Строки начиная с AccountBinding и с EventDispatchPlan (~45 сущностей) в GFM отображаются не таблицей. Это класс B14-2, на единственном владельце схемы.
- **Индекс владельцев:** `contracts/README.md` не изменён (тот же хеш в `PACKET_INDEX`). Новые владельцы `automation-policy-version` и `policy-mutation` лежат в `access-control.md`, но индекс относит к нему только «permissions, scope, epochs, locks…». По индексу они попадают в «прочие → спецификация».
- **Правка:** убрать пустые строки; добавить две строки в индекс.

### R16-B5 — Low, проявлено F7b/Self2/Self4 → корень N-33. Мелкие пробелы схемы
- `Conversation.revision` (`:51`) после введения `conversationSequence` («не revision», `:103`) не имеет определённого назначения, хотя §4 `:125` пишет «conversation revision/sequence».
- `HistoricalAuthorMapping` отсутствует в перечне сущностей с правилом revision (`:99`).
- `OutgoingCommand.policyId/policyVersion` (`:57`): не сказано, nullable ли они для human-команд.
- **Правка:** удалить колонку или определить её назначение; дополнить перечень; явно указать nullable для human.

---

## 3. Сверка привязок к корням и происхождения

| Привязка | Оценка |
|---|---|
| F1 → N-33/N-15; F2 → N-33/M-13; F3a, F4, F7b, Self1–4 → N-33; F6 → N-34; F9 → N-15; F10 → H-3/N-30; Editorial1 → L-2 | Согласен |
| F3b → N-36 (порождено R15), F4 (R15 ReadCursor), F7a → L-2/N-37 (R15 blocked_config) | Согласен: это проявления правок прошлого раунда |
| **F5 → N-5** | **Оспариваю как основную привязку.** Фраза стояла в абзаце отмены §15.3, который относится к M-2 («Cancel connector queued command»). Основной корень — M-2, N-5 — связанный. На статус не влияет: исправление подтверждено |
| **F8 → N-20** | **Оспариваю.** N-20 — это интеграция SEND_OMNI_MESSAGE. Закрытая таблица действий для omni-потомков в реестре R8 записана под H-3 («H-3 workflow actions»). Основной корень — H-3 |
| «8/17 порождены правками» | Подтверждаю для F3b, F4, F7a и Self1–4. Добавляются новые проявления этого B: R16-B1…B4 порождены правками R16, R16-B5 проявлен ими |

---

## 4. Статусы всех 66 корней

**closed_in_plan, регрессий в дельте R16 не обнаружено (51):** H-1, H-2, H-4, H-5, H-6; M-1–M-12, M-14; L-3–L-7; N-1, N-2, N-3, N-4, N-7, N-8a, N-8b, N-8c, N-9, N-10, N-11, N-13, N-14, N-16, N-17, N-18, N-21–N-29, N-31, N-35, N-38.

Оговорка: в этом B их заново полностью не перепроверял. Основание — мой полный A по редакции до правок, в котором они не всплывали, и отсутствие пересечения с изменёнными строками.

| Корень, затронутый R16 | Итог |
|---|---|
| H-3, L-1, N-5, N-12, N-20, N-30, N-32, N-34, N-36, N-37 | **closed_in_plan** |
| N-15 | **reopened — Medium** (R16-B1, порождено правкой) |
| N-6 | **reopened — Low** (R16-B2, порождено правкой) |
| M-13 | **open — Low** (R16-B3) |
| L-2 | **open — Low** (R16-B4) |
| N-33 | **open — Low** (R16-B5); основная часть F1/F2/F3a/F4/Self1–4 закрыта |

Итого: 61 закрыт, 5 открыто (1 Medium и 4 Low). Новых корней нет, всего 66.

---

## 5. Ограничения

- **Прочитано целиком:** реестр, `access-control.md`, `sending-ui.md:10-88`, раздел `workflow-execution.md:60-169`, §1–§15.4 и §15.11–§15.12 спецификации, `06-api.md:9-48`, `phase_1:40-60`, `phase_3:40-48`, хвост `coverage.md`, нужные фрагменты `decision-tables.md`.
- **По grep:** `phase_5`, `phase_6`, `05-models`, `automation-source-matrix`, `decisions`, `open-questions`.
- **Не перечитывал заново:** изменённые `research-connectors.md`, `access-source.md`, `ai-workflow-source.md`, `integration-map.md`, `license-inventory.md`, `09-automation-contract.md` (кроме grep на новые якоря), остаток §15.13–§15.27.
- **Исходники в этом этапе:** только `workspace-data-source.service.ts` (timeout, grep). Остальные факты по коду — из моего этапа A.
- **Недоступно:** внешние репозитории коннекторов и исторические отчёты, на которые ссылается реестр (`claude-*.md`, `residual.md` и др.). Привязки сверял только по тексту `registry.md`.
