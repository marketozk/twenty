# Stage B (R8): сверка всех 49 ID

**Итог: needs_revision.** Из 49 ID: closed_in_plan 47, open 2 (оба major), needs_evidence 0, новых ID нет. Я проверял текущий текст плана и исходники, а не заявления автора и не статусы прошлых раундов. Закрытие означает только, что контракт в плане есть; runtime-тесты T01–T33 не написаны и не запускались.

## Привязка находок A к существующим ID

| Находка A | Куда отнесена | Почему |
|---|---|---|
| F1: SEND_OMNI_MESSAGE в workflow с триггером не omni (DATABASE_EVENT, CRON, WEBHOOK, MANUAL) работает без omni reference, без закрытой таблицы действий и без слота бюджета | **H-3**, остаётся open, major | Тот же корень, что у H-3: граница полномочий привязана к наличию reference или admission, а не к тому, может ли исполнение дойти до omni-эффекта. Отсутствие бюджета следует из той же причины, поэтому M-13 повторно не открываю, а обобщение ключа бюджета включаю в правку H-3. |
| F2: Person merge через CommonMergeMany переписывает `messageParticipant.personId` обычным репозиторием (`common-merge-many-query-runner.service.ts:375-436`) | **M-5**, переоткрыт, major | Адаптер жизненного цикла из §15.2 переносит только ExternalIdentity. В итоге либо merge падает на guard из §15.1 (L-7), либо уходят сырые omni-события в обход §15.6. Сам guard L-7 сформулирован верно, ломается его стык с M-5. |
| F3: автоповтор шагов upstream (`scheduleStepRetry`, задержки до 15 с) не упомянут в списке законных ожиданий watchdog | **M-7**, примечание, не переоткрывает | Повтор идёт через `executeFromSteps` и проверяет fence; ключ эффекта не включает номер попытки, поэтому повтора эффекта нет. Худший исход — ложный, но видимый stalled при неудачно маленьком lease. Это пункт чек-листа и теста, не дефект плана. |
| Производительность FOR SHARE | **N-15**, примечание | Измерить в T19. На корректность не влияет. |

**Происхождение.**
- **H-3/F1.** Неполное исправление исходного плана. Проявилось после двух авторских правок: N-20 в R6 сделал SEND_OMNI_MESSAGE обычным действием workflow, а правка R8 ограничила проверку при publish триггером OMNICHANNEL_EVENT и исполнениями с reference.
- **M-5/F2.** Конфликт возник из-за правок: guard L-7 (R2/R5/R6) и подавление событий §15.6 (R2) наложились на адаптер M-5, охват которого не расширили.

Оба сценария укладываются в модель отказов §1. Нужны только штатные действия администратора (опубликовать workflow) или менеджера (слить Person).

## Все 49 ID

| ID | Статус | Обоснование (spec = implementation-spec.md) |
|---|---|---|
| H-1 | closed_in_plan | §15.1:246, ACL диалога до запроса во всех timeline/fallback путях, T21 |
| H-2 | closed_in_plan | §15.1:250 и §15.8:348, cleaners проверяют persisted marker, RESTRICT FK, T22 |
| H-3 | **open (major)** | Проявления R8 закрыты (design/09:43-47, design/06:66). Не закрыт путь F1: design/09:45 проверяет publish только для OMNICHANNEL_EVENT; spec:154 требует слот от root admission, которого у триггеров не omni нет |
| H-4 | closed_in_plan | §15.3:270, ledger и идемпотентный слот, T26 |
| H-5 | closed_in_plan | §15.4:282-288, fenced replay, restore_replay подавляет эффекты, T29 |
| H-6 | closed_in_plan | §15.2:262 и §15.7:340, correlation_pending, политика только при доказанном external, T24 |
| M-1 | closed_in_plan | §15.3:274, повторная проверка actor/policy/epoch при recovery, not-found не даёт права отправить |
| M-2 | closed_in_plan | §15.3:274 и §15.7:334,338, cancel tombstone, решение too_late принимает userbot |
| M-3 | closed_in_plan | §15.2:258, legacy namespace, без автоматической dedup между источниками |
| M-4 | closed_in_plan | §15.2:256 и §15.10:377, sourceEventKey отдельно от nativeMessageKey |
| M-5 | **open (major)** | F2: merge мигрирует участников через обычный репозиторий с событиями; адаптер §15.2:260 их не охватывает |
| M-6 | closed_in_plan | §15.5:298, по умолчанию metadata-only, хранение payload как явная политика, T32 |
| M-7 | closed_in_plan | §15.10:369, §15.17:445-447, §15.19:480-486, design/09 §3: стабильный workflowId-ключ, отказ в Retry до мутации, общий finalizer. F3 только примечание |
| M-8 | closed_in_plan | §15.8:352, отдельный владелец и схема crm_audit, preflight, T06 |
| M-9 | closed_in_plan | §15.5:292, optionValue плюс хэш набора значений, T30 |
| M-10 | closed_in_plan | §15.5:304, preflight имени и адреса тестовой БД, флаг не включается автоматически |
| M-11 | closed_in_plan | §15.5:300-302 и §15.19:490. По исходникам подтверждено, что reader группирует fast/slow/workspace. Отдельный ledger/runner, T33 |
| M-12 | closed_in_plan | §4:71 и §15.18:473, неизвестная identity остаётся unbound, импорт не создаёт Person |
| M-13 | closed_in_plan | design/09 §4: общий слот на admission, весь набор наследуется, без частичного commit, budget_exhausted с handoff. Бюджет для триггеров не omni входит в правку H-3 |
| M-14 | closed_in_plan | §15.3:276 и §15.18:471, conversationId обязателен |
| L-1 | closed_in_plan | §3:57, writer входит в ROB-764 |
| L-2 | closed_in_plan | open-questions.md:37-39 ссылается на §13 G01–G18 |
| L-3 | closed_in_plan | §15.5:296, catalog, объём проверяет T19 |
| L-4 | closed_in_plan | §15.1:250, при re-enable bindingId сохраняется |
| L-5 | closed_in_plan | §15.5:294, отзыв native role через тот же fence, T31 |
| L-6 | closed_in_plan | §15.5:306 и §15.16:441, права перечитываются на каждый batch |
| L-7 | closed_in_plan | §15.1:248 и §15.18:469. Guard корректен, конфликт с merge учтён в M-5 |
| N-1 | closed_in_plan | §15.6:315 и §15.12, все parents, artifact scope |
| N-2 | closed_in_plan | §15.6:319, QueueGrant, без него activation запрещена (G08) |
| N-3 | closed_in_plan | §15.9:360 и design/09:39,47: объединение констант, pausingTools=[], canAskHumans=false, проверка итогового набора |
| N-4 | closed_in_plan | §15.6:317, явное system-admin разрешение, аудит, ACL артефакта |
| N-5 | closed_in_plan | §15.7:325-338, таблицы journal, fencing у userbot |
| N-6 | closed_in_plan | §15.9:358, единый порядок блокировок, ограниченные повторы |
| N-7 | closed_in_plan | §15.7:342, неизменное capture generation, путь reconciliation |
| N-8a | closed_in_plan | §15.9:362, ограниченный ACL-запрос, индекс по результатам T19 |
| N-8b | closed_in_plan | §15.7:340, неизменный snapshot автора и исключение из rematch |
| N-8c | closed_in_plan | §15.6:317, principal API-key в T07/T08 |
| N-9 | closed_in_plan | §15.10:375-377; глобальный lookup по header подтверждён (`messaging-message.service.ts:83-89`) |
| N-10 | closed_in_plan | §15.11:381, managerReplyPolicy как gate |
| N-11 | closed_in_plan | §15.11:383-385, передача владения через доменную операцию |
| N-12 | closed_in_plan | §15.11:387, provenance и явный mapping |
| N-13 | closed_in_plan | §15.13 и §15.18:456-465; импорт `buildRecordShareGate` подтверждён, manifest и семейства описаны |
| N-14 | closed_in_plan | §15.14:412-423, класс и режим проверяются при создании, dispatch и recovery |
| N-15 | closed_in_plan | §15.15, без повышения SHARE→UPDATE; производительность только примечание |
| N-16 | closed_in_plan | §15.16, scoped fetchHistoryPage, page receipt |
| N-17 | closed_in_plan | §15.17:449-451, CrmRecordRevision |
| N-18 | closed_in_plan | §15.18:467, binding.read во всех metadata-путях |
| N-20 | closed_in_plan | §15.18:471, связка action закрыта; вопрос допуска к триггерам не omni отнесён к H-3 |
| N-21 | closed_in_plan | §15.19:488, controlEpoch отделён от revision |

## Минимальные правки для двух открытых ID

**H-3.** Любая версия workflow, где есть SEND_OMNI_MESSAGE или другая omni capability, проходит проверку закрытой таблицей действий при publish, независимо от типа триггера. Без серверного reference executor отклоняет такой шаг. Для триггеров не omni нужен durable root, `rootExecutionId = UUIDv5(workspace, event/revision, workflowId)`, с явной service policy и бюджетом по `rootKind + rootId`. Альтернатива для v1: разрешить только шаблон G17 без AI-контента.

Тест: T14/T25 для DATABASE_EVENT, CRON, WEBHOOK и MANUAL с AI_AGENT, CODE и SEND.

**M-5.** Адаптер жизненного цикла переносит omni-owned участников и связи через `withOmniRepositoryOptions` с аудитом в том же executor. CommonMergeMany исключает эти строки из generic-миграции.

Тест (T23): смешанные email- и omni-участники. Generic omni-событий 0, email ведёт себя как раньше, rollback сохраняет обе стороны.

## Тренд и ограничения

Число open major держится на уровне 2 (R7 было 2, сейчас 2), но корни сузились: каждый открытый ID теперь сводится к одному конкретному пути, подтверждённому по исходникам. Если применять ваш stop-condition, этот прогресс стоит учесть. Решение остаётся за вами.

В B я прочитал registry.md. Прежние A/B отчёты не перечитывал: статусы оценены по текущему плану и исходникам, без опоры на прошлые выводы. MCP и task-card не использовал.
