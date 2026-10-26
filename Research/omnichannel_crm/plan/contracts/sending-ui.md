# Отправка сообщений и совместный интерфейс

Нормативный контракт. Схема и UNIQUE: [спецификация §3](../implementation-spec.md#3-схема--rob-764). Владельцы правил: [индекс](README.md). Ссылки «§15.x» ниже означают сохранённые разделы спецификации. Новый runtime ещё не реализован.

<a id="command-admission"></a>

## Command и admission

Outbound: conversationId,text,readyFileIds,replyToMessageLinkId?,idempotencyKey,expectedControlEpoch,observedReplyRevision (human) → актуальные permissions/route/epoch → immutable pending Command + audit/event одним commit. Повтор ключа сравнивает также target/files, не только текст. После явного пользовательского решения повторить unknown создаётся новый commandId с replacesCommandId и предупреждением о возможном дубле.

<a id="command-states"></a>

## Состояния и неопределённый результат

cancelOwnCommand допускается при текущем доступе к conversation и если caller — автор command либо имеет отдельное command.cancel по G01. System close/takeover/policy-revoke cancellation остаётся отдельным trusted writer, не подменяет caller. Проверка, durable cancel request и audit атомарны; разрешение на запрос отмены не превращает unknown/too_late в cancelled. Cross-workspace/чужой transport owner всегда deny. T28: автор, делегированный менеджер, другой менеджер без права и revoke перед отменой.

При generation change binding выполняет durable sweep/outbox: ещё не enqueued pending Command старого поколения → failed с reason=stale_generation с audit/UI и без автоматической переподписи новым поколением. Для dispatching/accepted/outcome_unknown сначала status/cancel reconciliation с историческим commandId; timeout не превращается в not-sent. Новый enqueue под старым generation запрещён. После подтверждённого terminal outcome менеджер может создать новую авторизованную команду; неизвестный outcome остаётся видимым и governed FIFO/auto gates. T10/T28 проверяют reconnect между commit/claim/enqueue/ACK.


| State | Переход | Запрет |
|---|---|---|
| pending | для ai_turn проверить [retained producer fence](workflow-execution.md#turn-lifecycle); cancel/revoke до dispatch→cancelled; authorize+claim→dispatching | Нет send без текущих прав/route/generation; для non-human дополнительно automationEpoch, captured scope и workflowCancellationRefs по §15.19 (controlEpoch только admission/UI CAS) |
| dispatching | durable connector ACK→accepted; доказанный отказ до приёма→retry pending/failed; неоднозначный ответ→unknown | Нет нового commandId/provider resend по timeout |
| accepted | receipt/достоверное echo→sent; доказанный terminal reject→failed; неопределённость→unknown | Accepted не означает доставку |
| outcome_unknown | status/reconciliation→accepted/sent/failed либо остаётся unknown | Не угадывать failed и не слать повторно |
| sent | Подтверждённые delivered/read, ordered edit/delete | Старый timeout не откатывает sent |
| failed/cancelled | Новое явное намерение — новый ID | Старый lease не воскрешает send |

Recovery dispatching сначала status(commandId). Повтор разрешён только для идемпотентного connector enqueue того же ID при доказанном durable dedup. Единственный владелец provider retry — adapter/journal. Network call вне DB lock Twenty. Lease сам по себе не защищает provider от двойного вызова: fencing реализуется также в connector journal.

Редакционные контракты: canonical wire enum для неопределённой отправки в CRM, connector и userbot — outcome_unknown; прежнее unknown в prose/state sketches означает этот же terminal uncertainty, отдельного состояния нет. JSON Schema генерация ROB-764 устраняет оба написания из wire. Канонический trusted origin импорта — history_import; import является только описанием операции, не вторым enum. Внешний envelope не задаёт origin. History import никогда автоматически не создаёт Person и не вызывает business listeners: сохраняет external identity и разрешённые explicit links. Создание Person/обогащение после импорта — отдельная явно инициированная операция с обычными правами/audit и видимыми событиями; live auto-createPerson настройка не переносится на import. T16 проверяет отсутствие Person-created effects во время импорта.

<a id="reply"></a>

## Ответ на конкретное сообщение

Reply: replyToMessageLinkId принадлежит тому же workspace/conversation, доступен actor и имеет доказанный native ID. При admission capability reply должна быть supported; native reference сохраняется сервером в immutable Command. Hash включает reply link/native snapshot, target/body/files, но не expectedControlEpoch: это CAS precondition, не содержимое намерения. Повтор уже принятого key после текущей авторизации возвращает прежнюю Command при совпадении hash; CAS проверяется для создания новой команды, не заставляет повторный send. CAS conflict до commit не занимает key. Удаление/недоступность reply target либо неподдерживаемый reply даёт visible error, не silent send без reply.

<a id="fifo"></a>

## FIFO и restore ordering

Порядок outgoing v1 — FIFO первого durable connector enqueue по outboundSequence, выделенному при Command commit под conversation lock. B ждёт, пока каждый прежний A имеет доказанный durable accepted либо terminal reject/cancel до enqueue. Это относится и к explicit replacement C: он не обходит A или промежуточный B, ordering waiver отсутствует. Если принятие A неизвестно, UI показывает waiting_predecessor и replacement также ждёт; если acceptance A уже доказан, неизвестный provider outcome не мешает FIFO дальнейшего enqueue. Неопределённость принятия A блокирует автоматический enqueue B; status/reconciliation того же commandId может снять эту неопределённость. Поздний provider outcome_unknown не стирает уже доказанный факт durable acceptance/порядок journal. Connector/userbot обрабатывает принятые команды одного chat последовательно; receipt сохраняет journal sequence. Это порядок принятия/обработки, не гарантия порядка доставки/прочтения у провайдера. Explicit human replacesCommandId для unknown — уже предусмотренное отдельное намерение с предупреждением о возможном дубле и неопределённом порядке; оно не освобождает старую unknown команду и не включает auto. Никакого автоматического обхода неизвестного predecessor нет. T11: A slow/pending, B concurrent; lost acceptance ACK; proven accepted followed by unknown provider result; manual replacement с неизменённым старым outcome.

outboundSequence задаёт FIFO допуска команд в текущем журнале CRM; для connector это диагностическое поле, не unique key и не fencing token. Connector/userbot порядок — собственный durable enqueue journal order; idempotency ключ commandId. После DB restore прежние connector journal sequence/command IDs сохраняются, old orphan receipts остаются quarantine. Их нельзя вставлять как новые Commands с прежним local sequence или исполнять заново. CRM nextOutboundSequence восстанавливается выше max сохранённых локальных Commands до снятия fence; повторяемые числовые значения из потерянной части снимка не конфликтуют в connector, где uniqueness по commandId. Между restore epochs строгий creation-order не обещается; T29 проверяет потерянные A/B, повтор номера и отсутствие resend. Снятие fence требует уже заданного reconciliation, не сброса журнала.

<a id="echo"></a>

## Корреляция echo

Echo-before-receipt создаёт один Message по native key и позже дополняет command link. Correlation только по доказанным native/transport IDs, не text/time эвристике. Без correlation — видимая reconciliation pending, не скрытие возможного дубля. UI pending bubble переходит в canonical Message по commandId, а не показывает обе подтверждённые записи.

<a id="human-stale-view"></a>

## Подтверждение актуальной ленты

Human send требует observedReplyRevision — отдельную версию клиентского содержания, не SSE sequence. Conversation.replyRevision повышается под conversation lock при первом canonical входящем/внешнем исходящем сообщении клиентского диалога, его edit/delete и при commit каждой новой human или non-human Command. Собственный echo уже учтённой Command, delivery/read/status receipts, внутренние notes, assignments и прочие служебные события не повышают replyRevision. Для pending Command→Message correlation счётчик не повышается второй раз. API send возвращает {commandId, state, replyRevision, controlEpoch, mode}: Command identity/state из принятого намерения, а revision/controlEpoch/mode — актуальную разрешённую проекцию диалога под общим lock, включая повтор accepted idempotency key. Snapshot/SSE используют ту же проекцию. UI применяет control/reply версии монотонно, поэтому поздний ответ не откатывает состояние; takeover_on_send не заставляет следующую отправку ждать SSE. T12 проверяет две последовательные отправки из auto, lost ACK, concurrent takeover и перестановку ответов.

После current auth/idempotency lookup сервер сравнивает observedReplyRevision с актуальным replyRevision под conversation lock; mismatch → stale_view с разрешённым snapshot/revision, без Command и без занятия key. UI показывает новое клиентское содержание и требует явного подтверждения. Новое содержательное событие после подтверждения снова даёт stale_view; нет wildcard bypass. expectedControlEpoch остаётся отдельным precondition. Оба исключены из payloadHash. Уже принятый key/hash возвращает прежнюю Command после текущей авторизации независимо от старой revision. Две concurrent human sends с одной revision: первый commit повышает revision, второй stale_view. Последовательная отправка того же менеджера использует revision из первого ответа, не ждёт SSE и не исключается из общего контроля. Dispatch уже принятых команд этот precondition не сравнивает. T12/T13: burst delivery receipts и internal notes не блокируют send; concurrent customer content/two managers/echo/lost ACK/idempotency/confirmation проверяются отдельно. Автоматические sends governed roots/epochs, не human observedReplyRevision.

<a id="timeline"></a>

## Хронология ленты

Conversation/event sequence — порядок применения/курсор SSE/unread; stale-view использует отдельный replyRevision по своему контракту. Это не хронология UI. Лента сортируется по displayOccurredAt (валидированное исходное occurredAt, иначе сохранённый firstCaptureAt с пометкой capture), затем стабильному MessageLink.id. display time/source фиксируются при первом canonical insert; edit/receipt/replay их не меняют. История импортируется с исходным временем и располагается до более новых live сообщений, независимо от apply sequence. Provider sourcePosition используется для допустимого provider order/admission, не угадывается из opaque IDs. T16/T12: поздний импорт старой истории, одинаковые timestamps, missing source time, edit/delete и reconnect не дают дублей или нестабильных перестановок. Источник без времени явно имеет ограниченную хронологию.


<a id="ui"></a>

## UI и SSE

UI порции: ConversationList с server search/filter/cursor; Timeline по [контракту хронологии](#timeline), с cursor/unread и command correlation; Composer с text/files/reply и одним idempotencyKey на намерение до разрешения результата; CustomerPanel со штатными разрешёнными record links; Participants/Assignment; ConnectionStatus; InternalNote отдельный режим/endpoint; AuditPanel; AI mode/takeover. Lingui/Russian, штатные Twenty components. Transport credentials не попадают в браузер.

Каждый менеджер имеет свой вход; CRM хранит автора ответа, клиент видит подключённый аккаунт. Два осознанных ответа — разные команды. expectedControlEpoch защищает изменение назначения/режима от перетирания, а не обещает запрет параллельных сообщений людей. Presence/typing не источник авторизации. Unread — lastReadSequence по сотруднику; own sends/internal notes имеют явно тестируемую политику счётчика. ConversationReadCursor — отдельное состояние чтения, не ConversationMember. markConversationRead под policy SHARE повторно проверяет current conversation read ACL и берёт workspaceMemberId только из authenticated principal; id другого сотрудника не принимается. UPSERT монотонный GREATEST(old,new), последовательность ограничена сервером до последнего доступного сообщения диалога. Не создаёт участие/назначение/grant, не повышает policyEpoch/controlEpoch. Row доступен только своему сотруднику с текущим read ACL; revoke запрещает дальнейшие read/write cursor. Удаление участника не требует удаления его read cursor и не сохраняет ему доступ. T12: queue/team reader без membership отмечает прочитанное, membership и epochs неизменны; чужой cursor/hidden conversation denied, stale mark не уменьшает sequence, concurrent revoke сериализован общим policy fence.

SSE cursor связан с workspace/principal/restoreIncarnation/policyEpoch/scope; sequence монотонен внутри conversation. Mismatch только policyEpoch вызывает current ACL/scope recheck, а не reset: при сохранённом доступе cursor переиздаётся с текущей эпохой и прежней позицией. Unrelated assignment не создаёт snapshot storm; relevant revoke блокирует выдачу/очищает недоступный UI. Изменение restoreIncarnation и реальный gap/retention expired→snapshot-required и перечитывание разрешённого snapshot. EventId dedup на клиенте; reconnect не повторяет sends из локального state. Revoke убирает ленту/preview/cache без полагания на это как на server guard.


<a id="outcome-resolution"></a>

## Сверка неизвестного исхода по доказательствам

resolveCommandOutcome(commandId,evidenceRef,idempotencyKey) доступна только с отдельным command.reconcile и текущим доступом к binding/conversation. Actor/workspace серверные; произвольный terminal status/body/URL не принимается. EvidenceRef — ссылка на запись доверенного connector/userbot journal либо provider receipt, которую сервер сам получает через scoped adapter и проверяет по commandId, historical owner, binding, generation, native ID и payload hash. Скриншот, текст оператора, timeout и отсутствие записи у провайдера не доказывают отсутствие отправки.

Запрос durable в CommandResolutionRequest вместе с audit, key/hash conflict проверяется после current auth. Фоновая проверка имеет PG lease и идемпотентное восстановление; сеть вне locks, права повторно проверяются перед применением. Подтверждённый результат поступает в тот же IncomingReceipt/Command state machine с устойчивым evidence event ID; request result/audit фиксируются с применением outcome в одной транзакции. Потерянный ACK не создаёт новый send или повторный success audit. Receipt/Command monotonic guards запрещают откат sent и скрытое разрешение противоречивого evidence; conflict остаётся visible reconciliation. Для orphan после restore не создаётся отсутствующая Command.

Proof sent — достоверная provider/journal receipt о передаче; proof failed/cancelled — authoritative final evidence, исключающее поздний provider start (включая durable cancel fence). Если адаптер не может дать такую гарантию, результат request=unresolved и Command=outcome_unknown, auto gate остаётся закрыт. Это операция запуска проверки, не ручная кнопка признания доставки. T11/T28: forged/cross-tenant/contradictory evidence, revoke во время lookup, duplicate request/crash, поздняя receipt; ни один исход не инициирует resend. ROB-768 реализует UI/API/права и показывает unresolved без обещания срока.
