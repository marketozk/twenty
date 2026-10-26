# Точечная проверка исправлений B1–B9

**Вердикт по этой проверке:** все девять пунктов B1–B9 **закрыты** по фактическому тексту обновлённых нормативных файлов. Исправление B8 породило **одну новую проблему уровня Low** (V-1). Плюс есть две редакционные неточности. Пока V-1 не исправлена, чистого прохода по этой проверке нет. Исправление — одна-две фразы и один тест.

Это не новый полный проход A. Проверены только B1–B9, регрессии от их исправлений, карта источников, хэши и PACKET_INDEX. Runtime и тесты T01–T33 не запускались, продуктовые гейты не выбраны.

## Статус B1–B9

| ID | Статус | Где это видно в тексте |
|---|---|---|
| B1 (N-27) | **closed** | Шаг ingest-worker'а в spec §4 (`implementation-spec.md:109`) теперь звучит так: «scope-aware Message/participants + domain projection из ConversationTarget + link (matchParticipants/reconcile не вызываются; repository-adapter)». Слово `targetsOnly` в нормативных файлах больше не встречается. Остались только запрещающие упоминания в `phase_1:50`, `workflow-execution:290`, `integration-map:25` и факты из исходников в `transactions-audit-source:37,47,49`. В inventory §15.18 (`:502`) теперь есть и `reconcileMessageThreadTargets`. |
| B2 (M-7) | **closed** | `#cron-gap` (`workflow-execution.md:377`). Если курсор отстаёт, сначала в той же транзакции записывается `schedule.gap` за интервал (cursor, k), потом допускается k и курсор сдвигается. Дубликат или k≤cursor не создаёт ни run, ни gap, только поиск уже существующего intent. Поздний job за пределом допустимого опоздания даёт gap без догоняющего запуска. В T14-E есть случай «позднее k при cursor=N». |
| B3 (N-6) | **closed** | `access-control.md:104`. Правка очередей, умолчаний binding и жизненный цикл webhook-ключей — policy writers с `WorkspacePolicyState FOR UPDATE` до любых строковых блокировок. Допуск CRON (включая обычный сдвиг курсора) и сканер gap тоже берут UPDATE с начала транзакции. Под SHARE эти строки не меняются. Все такие писатели взаимно исключены глобальной блокировкой, поэтому отдельная позиция строк в порядке блокировок не нужна. |
| B4 (N-36) | **closed** | `workflow-execution.md:367,371`. Путь явно `POST /omnichannel/workflow-webhooks/:webhookBindingId`, что согласуется с `UNIQUE(workspaceId,webhookBindingId,keyId)` в §3 `:58`. `expiresAt/notBefore` ограничивают только допуск новых запросов. Окончание перекрытия при ротации не отменяет DELAY/WAIT/FORM. Явный отзыв (revoke) фиксируется под UPDATE: связанные intents/turns получают `terminal revoked` с `credential_revoked`, аудитом и DurableHandoff. Локальные pending отменяются, для удалённых состояний — `cancelRequested` и сверка. Индексы reference→key и Command/intent→reference обязательны, тест T25-F это проверяет. |
| B5 (N-2) | **closed** | §15.27 `:606`. Выключить или удалить **любую** очередь с сохранёнными диалогами, включая закрытые и назначенные, нельзя без явного переноса в активную замену. Перенос идёт пакетами, финальная проверка — под policy UPDATE. API `updateOmniQueue` (`06-api.md:23`) это повторяет. |
| B6 (N-37) | **closed** | §15.27 `:606` и `phase_1_data.md:53`. Реальная активация binding — только с ROB-766. В ROB-764 используются изолированные fixtures с тестовой авторизацией и синтетическим queue grant, без runtime-флага. Пробуждение `blocked_config` двойное: событие `DomainEvent(binding.config_changed)` в той же транзакции плюс typed consumer, перечитывающий `blocked_config` пакетами по индексу. Страховка — периодический housekeeping. Новые receipts при этом не создаются. |
| B7 (N-33) | **closed** | §15.27 `:610` и §3 `:42` (добавлен `payloadHash`). Аудит-контекст транзакции собирает для пары (ресурс, действие) первый before и последний after. Один redacted entry записывается тем же executor до COMMIT, это не afterCommit-буфер. Ошибка записи откатывает все изменения. Nested writers переиспользуют контекст. CREATE/UPDATE/DELETE — разные ключи действий, UPSERT ключуется по фактическому действию. Нужный случай есть в T06. |
| B8 (N-38) | **closed**, но см. V-1 | §15.27 `:608` и §3 `:74`. Значения `assignmentKind` — только `primary_owner/team`, строк collaborator нет. Участие хранится только в `ConversationMember`, `changeParticipants` пишет его через один policy writer. В документах «collaborator» больше нигде нет. |
| B9 (N-34) | **closed** | `06-api.md:22–24`: добавлены `activateBinding/updateBindingDefaults`, `updateOmniQueue` и `workflowScheduleGaps`. Чтение gaps не запускает replay. |

## Новая проблема

**V-1 · Low · порождена исправлением B8 · корень N-38.** Таблица `ConversationMember` теперь одновременно (а) единственный источник участия, который пишет policy writer с epoch, и (б) хранилище `lastReadSequence`. При этом:
- `markConversationRead` пишет курсор прочтения именно туда (`06-api.md:35`);
- непрочитанное считается по каждому сотруднику (`sending-ui.md:72`);
- P02 (`decision-tables.md:62`) относит изменение ConversationMember к policy UPDATE с `policyEpoch++`.

*Контрпример.* Руководитель или оператор читает диалог по правам очереди (`read_unassigned`) или команды, но участником не является. Строки ConversationMember у него нет. Тогда `markConversationRead` вынужден выбрать одно из двух:
1. Создать строку ConversationMember в обход единственного policy writer. Чтение тогда тихо превращает человека в участника без аудита и epoch.
2. Брать глобальную блокировку policy в режиме UPDATE и повышать `policyEpoch` на каждое прочтение. Это сериализует весь workspace и запускает повторную авторизацию всех идущих автоматизаций.

Хранить непрочитанное для не-участников при этом негде.

*Минимальная правка.* Отделить курсор прочтения от участия: либо отдельная таблица `ConversationReadCursor(workspaceId, conversationId, workspaceMemberId, lastReadSequence)`, монотонная, под SHARE и без epoch; либо флаг `isParticipant`, который меняет только policy writer, а курсор обновляется под SHARE без epoch. Тест в T12: не-участник отмечает прочитанное → 0 изменений участия, `policyEpoch` не меняется.

## Редакционные мелочи (не меняют поведение)

- В `automation-source-matrix.md:73` по-прежнему написано «40 source hashes», хотя в `automation-source-hashes.json` теперь 49 записей. Новые файлы присутствуют: `workflow-trigger.controller.ts`, `workflow-cron-trigger-cron.job.ts`, `reconcile-person-company-targets.job.ts`, `participant-target-reconciliation.service.ts` (`:47–50`). Описаны они в matrix `:78`.
- `#cron-gap` отдаёт предельное опоздание CRON на решение G07, но строка G07 в §13 (`:258`) его не перечисляет. Нужно добавить, чтобы гейт был учтён.

## Риск, который уже стоит под тестом

Каждый допуск CRON и каждая правка конфигурации берёт глобальный policy UPDATE. Это осознанный компромисс ради корректности, и `access-control.md:104` прямо ставит его под T19. Новой находкой я его не считаю, но это ещё одна причина, по которой результат T19 обязателен до активации.

## PACKET_INDEX и хэши

- PACKET_INDEX теперь пересчитан: стоит `stage: "R15 targeted B1-B9 verification after fixes"` и `source_hashes_verified: 49`, хэши изменённых документов обновлены (например, spec `0b5815…`).
- **Ограничение:** у меня есть только Read/Grep/Glob, поэтому SHA-256 ни документов, ни 49 исходников я вычислить не могу. Совпадение хэшей с содержимым я не проверял и полагаться здесь могу только на авторскую сверку.
- Тела исходников в этой проверке я заново не открывал: опорные факты по ним установлены в A и B, а исправления B1–B9 новых утверждений об исходниках не делают.

Использовал только Read/Grep/Glob внутри пакета, ничего не записывал и MCP/task-card не вызывал.
