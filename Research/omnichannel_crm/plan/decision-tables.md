# Конечные таблицы допуска реализации

26.10.2026. Объект R11: события, права и жизненный цикл отправки. Это свод контрактов [spec](implementation-spec.md) и [automation](../design/09-automation-contract.md), а не реализованный движок. При противоречии исправляются оба документа. Продуктовые G01–G20 не выбираются автором; таблицы определяют поведение после явной настройки либо безопасный отказ до неё.

Модель отказов: concurrent duplicate/reordered events; crash процесса в любой точке; недоступность одной зависимости; timeout/потеря ответа; Redis loss при сохранной PostgreSQL; revoke/takeover/import-live race; восстановление известного backup с reconciliation. Одновременная утрата данных и всех копий, захват root или ложь провайдера вне гарантии. При неизвестном исходе внешнего send — outcome_unknown, не exactly-once доставка.

## E. Событие → root → target

Общие условия: аутентифицированный источник, tenant binding, current generation либо отдельный recovery ingress; causal metadata назначает сервер. Admission, event, immutable dispatch snapshot (включая empty), target intents и общий budget коммитятся до enqueue. Durable consumer identity не включает опубликованную впоследствии версию. Импорт/restore никогда не получают право на автоответ только из-за повторной доставки.

| ID | Вход | Root / действие | Не допускается | Проверка реализации |
|---|---|---|---|---|
| E01 | Live message после trusted activation boundary | Один AutomationAdmission root | Второй root от replay или смены версии | T02/T14/T27 |
| E02 | conversation.created того же eligible message | Тот же root и quota, target claims общие с E01 | Дополнительный ответ за факт создания диалога | T27-B |
| E03 | Import, restore, origin/order неизвестен | Хранение/аудит; empty/suppressed либо quarantine/gap | Send из receivedAt или client-supplied origin | T16/T18 |
| E04 | Own echo, InternalNote | Хранение/корреляция/аудит, без customer admission | Новый root входящего клиента | T24 |
| E05 | assignment/status/CRM mutation из governed execution | Полный inherited covered root set | Сброс budget, потеря ancestry, частичный burst claim | T14-E/T27-C |
| E06 | Независимая authorized assignment/status/CRM mutation | domain_event + durable eventId | Root от текущей версии записи при replay | T14-E |
| E07 | CRON | scheduleId + planned UTC occurrence | retry time как новый source; слепой catch-up пропуска | T14-E |
| E08 | WEBHOOK | authenticated binding + required key/hash | Нет key или тот же key с другим payload | T14-E/T25-F |
| E09 | MANUAL | actor + required command key/hash | Повтор UI как новый root | T14-E/T25-F |
| E10 | Closed, G20 disabled | Message/unread + empty conversation_closed | Потеря сообщения или запуск send | T13/T24 |
| E11 | Closed, G20 explicitly enabled | Reopen + оба epochs++, admission только нового event по current mode | Воскрешение старого turn, human→auto | T13/T24 |
| E12 | Missing trusted per-record snapshot при sticky referenceRequired | Visible gap / deny affected dispatch | Подмена одним snapshot всего batch или live cache fallback | T14-E |
| E13 | Governed дочерний flow / повтор root+workflow | Inherit весь набор; вернуть существующий intent/outcome | Новая квота или новый run от version/step ID | T14/T27 |
| E14 | CRM effect/hop budget исчерпан, overlap target claims | Durable terminal handoff, без нового эффекта | Автопересборка/split, loop с новым root | T25-F/T27-D |
| E15 | Crash после DB commit до afterCommit/enqueue | Scanner pending/enqueued intent восстанавливает тот же ID из PostgreSQL; RUNNING crash → stalled/handoff по §15.19 | Потеря committed event или повтор произвольного эффекта | T14/T28 |

### Публикация между commit события и native listener

Канонические workflow IDs во всех omni keys/catalog/intents/исключениях — core.workflow.id и core.workflowVersion.id. Legacy workspaceWorkflowId/workspaceWorkflowVersionId допускаются только на входной границе: authoritative tenant-scoped mapping разрешает их в core IDs до сравнения, UNIQUE и UUIDv5; missing/ambiguous/cross-workspace mapping → deny/gap, не fallback к legacy key. Название workflowId в этом контракте всегда означает нормализованный core ID.

Для DATABASE_EVENT обязателен durable EventCoverageRegistry(workspaceId,objectMetadataId,eventKind,referenceRequired=true): активация governed подписки разрешена только после миграции и проверки всех producers данного object/event, включая generic CRUD/import/merge/lifecycle. Каждый их record event получает reference, даже при empty catalog. referenceRequired sticky: ordinary publish/deactivate/delete не снимают требование. Старые queued events без reference после включения получают visible gap/deny, не восстановление снимка по cache; обработка — отдельный explicit replay после reconciliation. Недоказанная полнота producers блокирует активацию; автоматический replay не добавляется.

OmniWorkflowSubscription сохраняет workflow-level cancellationEpoch и tombstone по coreWorkflowId, в том числе после ordinary publish/delete. Admission фиксирует capturedCancellationEpoch в intent. Publish/archive меняет active subscription/target eligibility для новых событий, но НЕ cancellationEpoch; ordinary publish отключает новое governed matching, не отменяя pinned intents. Explicit deactivate/delete через любой API/SDK/sync путь повышает cancellationEpoch под тем же policy/lifecycle fence и пишет audit. Start/resume/effect сравнивает captured epoch с текущей retained row: mismatch → terminal cancelled+audit/handoff; reactivation epoch не сбрасывает. Отсутствие обязательной row — gap/deny. CoreWorkflowVersionStatus ACTIVE/ARCHIVED/DEACTIVATED не является oracle отмены старого intent; hooks должны работать и при деактивации текущей ordinary версии.

Workflow cancellation применяется и к уже созданной исходящей Command. Она хранит immutable workflowCancellationRefs (canonical workflowId + capturedCancellationEpoch всех governed workflow в producer lineage; прямой agent без такого предка имеет пустой набор). Dispatch/recovery проверяет все refs до нового enqueue. Explicit deactivate/delete под общим UPDATE fence повышает epoch, отменяет соответствующие локальные pending Commands и пишет durable cancelRequested/outbox для dispatching/accepted/outcome_unknown; индексация workspace+referenced workflowId обязательна. Late remote enqueue покрывается tombstone userbot, too_late/timeout остаётся reconciliation; уже начатую отправку нельзя отозвать. Publish/archive не меняет refs или epoch, unrelated workflow не отменяется.

Ниже один canonical coreWorkflowId, обе версии соответствуют одному виду события. G — governed, O — ordinary. «Target нет» включает сохранённый empty/filter-miss. Explicit deactivation/current deny отменяет governed intent; archive при публикации сам по себе его не отменяет.

| При commit | При listener | Target в snapshot | Governed запуск | Native enqueue |
|---|---|---|---|---|
| O | O | нет | нет | обычный путь |
| O | G | нет | нет, visible empty/not_governed_at_source; без обязательной reference — gap | нет: не оформлять задним числом |
| G | O | v1 | только pinned v1 | нет: workflow был governed при commit |
| G | G | v1 | только pinned v1 | нет |
| G | O | empty | нет | нет |
| G | G | empty | нет | нет |
| G | O/G | v1, затем explicit deactivate/delete | cancelled по workflow cancellationEpoch + audit | нет |

Filter-miss вычисляется при admission commit по pinned декларативному filter и transaction-consistent authorized source/relationship values. Результат и версия фильтра сохраняются в immutable plan; позднее enrichment/current cache его не пересчитывает. Фильтр с неподдержанным внешним/асинхронным чтением не допускается к activation. O→G с валидной empty reference получает видимый not_governed_at_source; старое событие без обязательной reference получает gap (не выдуманный empty snapshot).

Для O→O сохраняется upstream ordinary контракт, не обещается новая durable exactly-once семантика. Для остальных строк replay возвращает прежний intent/empty outcome. Новые governed версии не становятся дополнительными targets старого события. Явный replay — отдельная audited операция с сохранением effect ledger.

## P. Изменение → блокировка → проверка прав

| ID | Изменение | Lock / версии | Продолжение ранее принятой операции |
|---|---|---|---|
| P01 | Grant/revoke, role/team/membership | Policy UPDATE; policyEpoch++ | Пересчитать исходный scope; relevant revoke → deny/handoff |
| P02 | Assignment/owner/ConversationMember | Policy UPDATE; policyEpoch++, controlEpoch++ для управления диалогом | Human dispatch не сравнивает старый controlEpoch; текущие права обязательны. AutomationEpoch только от assignment не меняется |
| P03 | Stage/pipeline/options/StageRule | Policy UPDATE; policyEpoch++ | Пересчитать stage visibility/transition и captured context, не только conversation grant |
| P04 | Identity person link/unlink, CRM targets, parent edges | Policy UPDATE; policyEpoch++ | Rebind A→B блокирует старый output с A; grant на A сам по себе недостаточен; scope на B не расширяется |
| P05 | Mode/takeover/managerReplyPolicy/pause external reply | UPDATE policy lock + policyEpoch++; controlEpoch/automationEpoch++ по spec | Старый non-human intent terminal stale + durable handoff, без refresh |
| P06 | Close/reopen | UPDATE policy lock + policyEpoch++; controlEpoch++/automationEpoch++; короткая общая transaction | Close запрещает новый dispatch; remote cancel подтверждается отдельно. Reopen старые commands/turns не оживляет |
| P07 | Новое сообщение | revision/sequence++; без controlEpoch/automationEpoch | Входящее не меняет controlEpoch, но требует stale_view/подтверждения нового observedSequence по §15.26 |
| P08 | Несвязанный policy change | policyEpoch++ | Повторная авторизация прежнего scope/edges разрешает продолжить; export не начинается заново |
| P09 | Metadata sync/import/AI/generic CRUD/merge/lifecycle пишет P01–P04 | Тот же UPDATE до начала, mutation+epoch+audit одним executor | Нет обхода через другой writer; неизвестный policy attribute/writer блокирует activation |
| P10 | SSE/export/download | SHARE на короткую transaction выборки, каждый новый пакет/retrieval recheck | Отзыв блокирует следующую выдачу; отданные байты не возвращаются |
| P11 | Restore старой БД | Внешний access fence; invalidate sessions/keys; reconciliation grants | Старые grants не доказательство; без внешнего evidence default deny |
| P12 | Смена статуса без close/reopen | UPDATE/policyEpoch++; controlEpoch++; без automationEpoch | Новый stale UI CAS конфликтует; принятая Command проверяет current rights |
| P13 | Explicit workflow deactivate/delete | Policy/lifecycle UPDATE; cancellationEpoch++ и cancel outbox атомарно | Локальные pending отменяются; переданные Commands получают cancelRequested. Dispatch/recovery сверяет workflowCancellationRefs, ancestor refs наследуются; publish не равен cancel |

Общий порядок locks: policy → sorted bindings/routes → conversations → identities → CRM records → dispatch/budgets(sorted roots) → commands/receipts/turns. Нет SHARE→UPDATE upgrade; bounded restart с прежним idempotency key. LLM/network вне locks. Проверки реализации: T10/T13/T18/T19/T22/T29/T31.

### Отправитель × режим (только открытый диалог)

Все строки дополнительно требуют текущие rights, route/generation, валидный immutable target binding; для non-human также неизменный captured ResourceScope/edges, workflowCancellationRefs и отсутствие invalidating control event. Для non-human — точный automationEpoch; для уже принятой human Command — без сравнения UI controlEpoch. Governance/reference и конечные budgets действуют для всех non-human. Human Command фиксирует conversation/binding/target/files при admission; проверка их принадлежности и current ACL не означает наличие у человека LLM captured context.

| Sender | human | assist | auto |
|---|---|---|---|
| human composer | send | send | explicit takeover либо atomic takeover_on_send; после admission режим human |
| AI / AI descendant | deny | draft, без Command | send |
| deterministic ordinary workflow reply | deny | deny | send |
| service notification | только approved G17 template | только approved G17 template | route policy + approved G17 template |

Closed сильнее любой строки/G17. Missing provenance не считается service notification. G17 по умолчанию disabled. `setMode(auto)` отказывает при любой human Command в **pending, dispatching, accepted, outcome_unknown**, включая cancelRequested без подтверждённого terminal outcome. Проверяется под общими locks с send admission. Sent/failed/подтверждённая cancelled не блокируют переключение сами по себе. При неразрешённом unknown блок auto намеренно сохраняется без срока; ручной reconciliation с evidence может дать terminal outcome, но кнопка «считать отправленным/неотправленным» без доказательства не добавляется.

## C. Command → подтверждение → Message / Attachment

Каноническое имя неопределённого состояния: `outcome_unknown`; сокращение «unknown» в пояснениях означает его же. Command ID, actor/target/payload hash неизменны. Receipt evidence проверяется по workspace/binding/generation/command/native ID; чужое или противоречивое evidence (включая актуальный accepted ACK после локальной cancel/failed-preaccept) даёт видимый reconciliation, не правку чужого Message.

| ID | Состояние / наблюдение | Результат / внешний эффект |
|---|---|---|
| C01 | Admission с новым key | pending + audit/event одним commit; non-human slot/effect mapping в том же commit после LLM |
| C02 | Повтор key+тот же hash | Тот же Command; другой target/body/files hash → conflict |
| C03 | pending + current authorization и workflowCancellationRefs | dispatching, immutable commandId; network после commit |
| C04 | dispatching + durable connector ACK; outcome_unknown + актуальный authoritative accepted status | accepted; ещё не sent, блокирует human→auto |
| C05 | dispatching/accepted + timeout/потеря ответа | outcome_unknown; status/reconciliation по тому же ID, без нового provider send |
| C06 | dispatching/accepted/outcome_unknown + доказанный send/native echo | sent + один canonical Message/MessageLink |
| C07 | Доказанный отказ ДО приёма | bounded retry той же idempotent enqueue либо failed по политике; не новое намерение |
| C08 | dispatching/accepted/outcome_unknown + подтверждённый terminal reject | failed; не новая отправка автоматически |
| C09 | Локальная pending, remote enqueue не мог начаться + cancel | cancelled атомарно с fence/audit |
| C10 | dispatching/accepted/unknown + cancel/close/revoke | durable cancelRequested; remote terminal cancelled только после userbot journal proof |
| C11 | cancel vs provider call | Winning tombstone → cancelled и 0 sends; provider_started/too_late → reconcile реальный sent/unknown. CRM lock не распределённый lock провайдера |
| C12 | sent + поздний timeout/ACK | sent сохраняется; delivery/read отдельные подтверждённые атрибуты |
| C13 | echo раньше ACK | Доказанная correlation → тот же Message; иначе correlation_pending, не external human по догадке |
| C14 | Подтверждён Command→Message | Attachment parent атомарно command=NULL/message=id, XOR; file/ACL/provenance сохраняются, повтор idempotent |
| C15 | Неизвестный DB commit | Lookup stable effect/command ID; нет evidence → stalled/handoff, не новый send/LLM retry |
| C16 | Cancelled/failed terminal intent + late worker | Нет resurrection; противоречивое evidence требует reconciliation |
| C17 | Explicit retry неизвестной отправки пользователем | Новый commandId+replacesCommandId, предупреждение о возможном дубле; прежний outcome не переписывается |
| C18 | Command retention после C14 | Не удаляет Message-owned file; unknown correlation не теряет файл |

Никакой abstract model не доказывает межпроцессный fencing: T11/T28 обязаны проверить central connector И userbot journal на настоящих транзакциях. До отдельной интеграции runtime send выключен. Очередь PostgreSQL хранит ответственность за восстановление; Redis presence/lease TTL не свидетельствуют, что provider effect не произошёл.

## Источники и границы проверки

Перечитаны реальные upstream точки, а не только имена файлов:

- [WorkspaceEventEmitter](../../../packages/twenty-server/src/engine/workspace-event-emitter/workspace-event-emitter.ts): emitDatabaseBatchEvent строит `{name,workspaceId,objectMetadata,events}`; [batch type](../../../packages/twenty-server/src/engine/workspace-event-emitter/types/workspace-event-batch.type.ts) не содержит durable per-record reference. E12 требует нового внутреннего контракта и всех его producers/consumers.
- [Database listener](../../../packages/twenty-server/src/modules/workflow/workflow-trigger/automated-trigger/listeners/workflow-database-event-trigger.listener.ts): getDatabaseEventListeners читает workflowAutomatedTriggerMaps; это текущий cache, не snapshot. [Trigger job](../../../packages/twenty-server/src/modules/workflow/workflow-trigger/jobs/workflow-trigger.job.ts) отклоняет не-ACTIVE version. Матрица publish требует изменения обоих путей вместе.
- [Merge runner](../../../packages/twenty-server/src/engine/api/common/common-query-runners/common-merge-many-query-runner.service.ts): relatedRepository.runMutation меняет parent через тот же transactionScope. P04/P09 требуют domain partition/epoch/audit перед этим путём, а не только API guard.
- Остальной inventory и 40 закреплённых hashes: [source matrix](../implementation/automation-source-matrix.md), [hashes](../implementation/automation-source-hashes.json). Новые omnichannel guards/entities отсутствуют; описанные таблицы не выдаются за текущее поведение upstream.

## Проверяемый допуск

1. В таблицах нет конфликтующих исходов в заявленной модели отказов; сценарии связаны с будущими T-тестами. Продуктовые gates остаются до активации, не блокируют написание изолированных schema/tests сами по себе.
2. [Абстрактная проверка](verification/check_decisions.py) проверяет ручные publish/identity/version/cancel fixtures; 12 sender×mode строк со всеми комбинациями семи guards; outstanding human states с cancelRequested; состояния Command и явно наблюдаемый reconciliation. Она НЕ перебирает полную модель E01–E15/P01–P13/C01–C18, uniqueness Message, hash conflict, Attachment XOR, SQL/locks, реальные эффекты или полноту writers. Guards дают executable specification, не независимое доказательство реализации; negative controls проверяют наблюдаемость каждого заявленного guard. Остальные строки проверяются независимым чтением сейчас и T-тестами будущей реализации. ACK в модели — актуальное авторитетное journal evidence о принятии, а не любое запоздавшее сетевое ACK; проверка подписи/порядка/version вне абстракции.
3. Независимый Claude Code consult проверяет весь этот конечный объект и его соответствие spec/source. Его verdict отдельно от общего fresh full pass проекта. Новые дефекты исправляются в spec/API/таблице вместе и учитываются в registry.
4. ROB-772 можно закрыть только по её общему acceptance, не автоматически по зелёному счётчику модели. Начало ROB-764, rollout и приёмка остаются разными решениями. Результат текущей проверки фиксируется в [review-result](cross-review/review-result.md).

## Дополнительные границы таблиц

Правила §4/7/15.24 implementation-spec дополняют таблицы: protected reads только primary; canonical ConversationTarget/revision; reply native snapshot/hash; FIFO первого durable enqueue с отдельным monotonic acceptance evidence. Это ещё не охвачено абстрактной моделью. ConsumerReceipt и OmniWorkflowRunIntent — разные сущности (два event kinds одного root могут иметь один intent). Unknown human command сохраняет C-gate на auto; административное подтверждение без provider evidence его не снимает. T08/T10/T11/T12/T14/T23 — будущие integration fixtures.

Human stale-view admission использует observedSequence (§15.26), отдельно от controlEpoch и dispatch epochs; duplicate key/hash возвращает старую Command. Native permission snapshot для protected query загружается из primary в fenced transaction. C17 manual replacement не обходит FIFO unknown-acceptance predecessor. Эти дополнительные правила не покрываются check_decisions.py; T10/T12/T14/T31 предстоят.
