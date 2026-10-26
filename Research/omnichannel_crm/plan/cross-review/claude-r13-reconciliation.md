# Этап B: сверка находок с текущими контрактами (не новый полный проход)

**План готов к реализации, вердикт: ready_for_implementation.** Это именно сверка прежних находок, а не новый полный проход. Все 63 известные причины закрыты в контрактах-владельцах (`closed_in_plan`). Открытых нет, статус `needs_evidence` никому не присвоен. Все пять находок этапа A закрыты по существу. Нашёл четыре новых мелких расхождения, все в производных документах; реализацию они не блокируют.

**Как проверял.** Перечитал текущие версии владельцев: спецификацию §3, §4–§15.26, `access-control.md`, `sending-ui.md`, `workflow-execution.md`. Плюс `06-api`, `decision-tables`, `phase_0`, `phase_1`, `phase_4`, `phase_7`, `open-questions`, `02-behavior`. Закрытие по слову автора не принимал: каждую ссылку открыл и проверил по тексту. Сохранённые адреса §15.x ведут к своим владельцам; все проверенные ссылки на якоря рабочие. Исходники повторно не перечитывал: факты, сверенные на этапе A, остались в силе (`core.datasource.ts`, `workspace-orm.manager.ts`, `upgrade-sequence-reader.service.ts`, `run-workflow.job.ts`, `resolve-encryption-keys-or-throw.util.ts`, MessageThreadTarget, ConnectedAccount).

Сокращения в ссылках: `spec` — `implementation-spec.md`, `AC` — `access-control.md`, `SU` — `sending-ui.md`, `WE` — `workflow-execution.md`.

## Сверка 63 известных причин

| ID | Статус | Где определено и чем проверяется |
|---|---|---|
| H-1 | closed_in_plan | spec:274 §15.1 (доступ к диалогу проверяется до запроса); T21 spec:280 |
| H-2 | closed_in_plan | spec:278, §15.8 spec:376, TrashCleanup spec:531; T22 |
| H-3 | closed_in_plan | AC:17 (#scope); T25 spec:306 |
| H-4 | closed_in_plan | WE:348 (#action-idempotency: сохранённый вызов инструмента и effectOrdinal), WE:264-266 (fence хода), WE:151; T26 |
| H-5 | closed_in_plan | spec:310-316 §15.4 (origin=restore_replay подавляет эффекты, fence); T29 |
| H-6 | closed_in_plan | spec:290, spec:368, provenance spec:557; T24 |
| M-1 | closed_in_plan | spec:302 (после сбоя повторно проверяются actor/policy/epoch); T28 |
| M-2 | closed_in_plan | spec:302, таблица `command_cancel` и граница userbot spec:362,366; T28 |
| M-3 | closed_in_plan | spec:286 (отдельное пространство legacy-ключей, без автоэффектов); T16. Сам факт о SaleBot.history взят из research-connectors |
| M-4 | closed_in_plan | spec:284 (варианты событий против одного логического сообщения, тесты mapping до включения адаптера); T01/T11. Факт о журнале MAX взят из research-connectors |
| M-5 | closed_in_plan | spec:288 (merge сначала делит строки omni и обычные); T23 |
| M-6 | closed_in_plan | spec:326; T32; G10 |
| M-7 | closed_in_plan | WE:276-278 (#trigger-registration), WE:284, WE:342; T14 |
| M-8 | closed_in_plan | spec:380, spec:128; G15; T06 |
| M-9 | closed_in_plan | spec:320; StageRule spec:69; T30 |
| M-10 | closed_in_plan | spec:332 (preflight тестовой БД); G14 |
| M-11 | closed_in_plan | spec:330, 382, 505; T33. Группировку команд подтвердил по коду на этапе A |
| M-12 | closed_in_plan | spec:100; SU:29; T02/T05/T16 |
| M-13 | closed_in_plan | WE:270 (#turn-lifecycle), WE:155; T27 |
| M-14 | closed_in_plan | WE:226 (#design-49), WE:296 (#send-action); T14 |
| L-1 | closed_in_plan | spec:86 (запись аудита своих изменений появляется уже в ROB-764) |
| L-2 | closed_in_plan | open-questions:24-33: устаревшего статуса и spike больше нет |
| L-3 | closed_in_plan | spec:324; T19 |
| L-4 | closed_in_plan | spec:278 (re-enable сохраняет bindingId), SU:15; T11 |
| L-5 | closed_in_plan | spec:322, AC:11; T31 |
| L-6 | closed_in_plan | spec:334, spec:460; T10/T16 |
| L-7 | closed_in_plan | spec:276; T22 |
| N-1 | closed_in_plan | spec:343-345; T08/T21; инвентаризация до первого патча ROB-766 |
| N-2 | closed_in_plan | spec:347, OmniQueue и QueueGrant spec:70-71, правила claim spec:82; G08; T12 |
| N-3 | closed_in_plan | WE:63 (#design-11), WE:79; T27-A |
| N-4 | closed_in_plan | spec:345; T07/T08 |
| N-5 | closed_in_plan | spec:355-366; T11/T28; ворот на деплой G13. Журналы userbot проверены только по research-connectors |
| N-6 | closed_in_plan | AC:37-41 (#lock-protocol). Блокировка строки хода (turn) стоит в конце общего порядка; со сканером противоречий нет (WE:264) |
| N-7 | closed_in_plan | spec:370, spec:314, spec:568, SU:15; T11/T18 |
| N-8a | closed_in_plan | spec:390; T12/T17/T19 |
| N-8b | closed_in_plan | spec:368 и MessageLink.immutableAuthorSnapshot spec:46; T24 |
| N-8c | closed_in_plan | spec:345; T08 |
| N-9 | closed_in_plan | spec:403-405; T01/T17 |
| N-10 | closed_in_plan | AC:70 (#takeover), AC:57; G06; T13/T24 |
| N-11 | closed_in_plan | spec:411-413; T22/T31 |
| N-12 | closed_in_plan | spec:415 и поля MessageLink spec:46; T16 |
| N-13 | closed_in_plan | spec:430-436, spec:484; G18; T20 |
| N-14 | closed_in_plan | AC:53, AC:72; T13/T24 |
| N-15 | closed_in_plan | AC:31 (#epochs), AC:39; T10. Проверка в работе — будущая |
| N-16 | closed_in_plan | spec:454-460, ImportPageReceipt и ImportPageItem spec:61-62; T11/T16 |
| N-17 | closed_in_plan | spec:468-470; T30 |
| N-18 | closed_in_plan | spec:486; T08 |
| N-20 | closed_in_plan | WE:296; T14/T28 |
| N-21 | closed_in_plan | AC:47 (#control-cas); replyRevision отделён от revision и controlEpoch (spec:44); T10/T12 |
| N-22 | closed_in_plan | spec:529, 559-561; T18/T29 |
| N-23 | closed_in_plan | AC:78-86 (#closed-status); G20; T13/T24 |
| N-24 | closed_in_plan | spec:58 |
| N-25 | closed_in_plan | spec:545; T15/T17 |
| N-26 | closed_in_plan | AC:9; T08/T10 |
| N-27 | closed_in_plan | spec:65, spec:140; T10/T13/T23 |
| N-28 | closed_in_plan | SU:35 (#reply); T11/T12 |
| N-29 | closed_in_plan | SU:41-43 (#fifo); T11 |
| N-30 | closed_in_plan | AC:19; API summarizeConversation (06-api:31); T12/T25 |
| N-31 | closed_in_plan | AC:11; T10/T31. Проверка в работе — будущая |
| N-32 | closed_in_plan | SU:63 (#timeline); T12/T16 |
| N-33 | closed_in_plan | spec:44 (queueId, replyRevision), 46 (автор, provenance, correlation), 48 (поля отмены, замены, класса отправителя и fence хода), 61-64 (страницы импорта, DurableHandoff, ReplayRequest), 70; этапы миграций spec:82 |
| N-34 | closed_in_plan | 06-api:24-33, у каждой строки ссылка на владельца |
| N-35 | closed_in_plan | UNIQUE без activationVersion (spec:57), монотонная граница (spec:118), phase_1:47; T01/T16. Остался устаревший текст в design/02, см. B-3 |

## Что стало с находками этапа A

| Находка A | Итог | Чем подтверждено |
|---|---|---|
| H1: нет fencing хода ИИ | **closed_in_plan** | WE:264-268: лиз, heartbeat и сканер в PostgreSQL; проверка fence в той же транзакции, что любая мутация, слот или Command; поля producerTurnId и capturedTurnFence в Command (spec:48); тест зомби-воркера в T27/T28. Остаток: B-1 |
| M1: неполная схема | **closed_in_plan** | см. N-33 |
| M2: stale_view завязан на SSE sequence | **closed_in_plan** | SU:55-57: отдельный replyRevision; квитанции, заметки и назначения его не повышают; новый revision приходит в ответе на отправку. Решение автора не исключать собственные команды отправителя корректно: последовательная отправка берёт revision из ответа сервера. Остаток: B-2 |
| M3: бессрочная блокировка auto | **closed_in_plan** | Ворот G13 (spec:253): до выбора владельца auto запрещён, план риск за владельца не принимает; AC:92. Замечание: пункт вписан в строку G13 про размещение сервисов, по смыслу ему место в отдельной строке |
| M4: неполный список API | **closed_in_plan** | 06-api:24-33 |
| L1: монотонность границы активации | **closed_in_plan** | spec:57, spec:118. Остаток: B-3 |
| L2: смена generation | **closed_in_plan** | SU:15: `failed_stale_generation` для ещё не отправленных, сверка для неопределённых |
| L3: ключ эффекта ИИ | **closed_in_plan** | WE:348 |
| L4: повтор эпохи после restore | **closed_in_plan** | spec:66 и spec:559 (restoreIncarnation). Остаток: B-4 |
| Редакционное | **closed_in_plan** | Пустых якорей и дублей больше нет; в примере envelope есть sourcePosition и sourceVariant (06-api:54-55); phase_0 в пакете есть |
| R1: конкуренция за блокировку политики | Остаётся риском, не дефектом | Отложен до ворота T19 (spec:521). Безопасность нагрузки не измерена |

## Новые расхождения (все low, реализацию не блокируют)

- **B-1. В правилах отправки Command не упомянут fence хода ИИ.** Сам владелец, WE:266, правило задаёт верно. Но в таблице состояний Command (SU:20, строка pending) и в decision-tables C03 проверка producer turn fence не перечислена. Тот, кто пишет dispatch по `sending-ui`, может её пропустить. Там же: новый терминальный исход `failed_stale_generation` (SU:15) отсутствует в таблице состояний. Правка: добавить «для ai_turn — retained producer fence» в строку pending и в C03, а `failed_stale_generation` оформить как причину внутри состояния failed.
- **B-2. Устаревший термин observedSequence.** Остался в `design/04-testing.md:23` и `coverage.md:41`. Противоречит владельцу (SU:55). Правка: заменить на observedReplyRevision.
- **B-3. Старый ключ уникальности admission.** В `design/02-behavior.md:68` ещё записан UNIQUE с activationVersion. Шапка документа подчиняет его спецификации, поэтому вред небольшой, но ключ нужно привести к spec:57.
- **B-4. restoreIncarnation есть не во всех ссылках.** По spec:559 пару (restoreIncarnation, policyEpoch) хранят все ссылки на исполнение и курсоры. Но в перечне полей TrustedExecutionReference (WE:330) и в описании курсора SSE (SU:74) этого поля нет. Правка: добавить его в оба места.

## Готовность и её пределы

- **Готовность к реализации.** План можно реализовывать по ROB-764 → 771 в указанном порядке; B-1…B-4 стоит поправить в первом же правочном коммите документов. Это не означает готовности к выкатке и не означает, что какие-либо проверки пройдены: T01–T33 — будущие тесты, G01–G20 остаются воротами активации, решений владельца по ним нет.
- **Внешние доказательства недоступны.** Репозиториев юзерботов и коннектора (C/H/M) в пакете нет. Факты о журнале MAX, SaleBot.history, журналах userbot, cancel tombstone и status lookup взяты только из `research-connectors.md`. Контракты здесь написаны так, что при отсутствии доказательства система отказывает (fail-closed) и требует mapping-тестов и проверки перед переносом. Сама проверка не выполнена.
- **Чего я не проверял.** Ссылки phase_0 на `version-and-deploy.md`, DEVLOG и `current-steps.md` ведут на файлы вне пакета, поэтому заявление о прошлом обновлении демо не проверено. Хеши файлов и совпадение baseline `01beb156` с закреплённым `729f6236` не пересчитывал: доступны были только инструменты чтения. Исходники фронтенда не смотрел.
