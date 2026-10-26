# Контракты API v1

[Единый контракт автоматизации](09-automation-contract.md) определяет инструменты, stable workflow identity, pausing и общую квоту ответов. Текущий допуск и ограничения — [STATUS](../STATUS.md); проектируемые функции ещё не реализованы.

Уточнение 26.10.2026: [подробный план всего проекта](../plan/implementation-spec.md), особенно раздел 15, задаёт lifecycle, canonical source keys, scoped AI, restore и fork migrations. Схематичные ключи/названия ниже не заменяют эти точные контракты.

Ниже **проектируемые**, ещё не работающие операции. Публичные API Twenty сохраняются; новые команды используют те же session/workspace guards, а транспортные credentials имеют отдельную узкую область. Проверенные существующие точки расширения: APP channels/ingestMessages, messaging transaction services, AgentRunService и workflow executor.

## Браузер -> Twenty

GraphQL queries/mutations для команд и чтения; существующая инфраструктура authenticated subscriptions/SSE для обновлений. Нативный экран в twenty-front не ограничен fetch bridge SDK. Точное имя wire-операций фиксируется при schema generation; таблица определяет их назначение.

| Операция | Вход / эффект |
|---|---|
| conversations / conversationMessages | Фильтры, cursor, page limit; ACL применяется до выдачи, count и сумм |
| sendConversationMessage | conversationId, текст/готовые file IDs, replyToMessageLinkId nullable, idempotencyKey, expectedControlEpoch, observedSequence (human); сервер назначает actor/workspace, создаёт Command |
| linkConversationTarget / unlinkConversationTarget | conversationId, objectMetadataId, recordId, expectedTargetRevision (0 для отсутствующего edge); current ACL обеих сторон, canonical core edge и native projection атомарно; повтор/stale правила spec §7 |
| addInternalNote | conversationId, body, idempotencyKey; не вызывает внешнюю отправку |
| assignConversation / changeParticipants | expectedControlEpoch, разрешённые workspaceMember IDs; проверка права назначения и доступа получателя |
| setConversationMode / takeover | mode, expectedControlEpoch; атомарное увеличение controlEpoch + automationEpoch и отмена pending non-human команд прежнего automationEpoch |
| transitionOpportunity | opportunityId, targetStageValue, expectedStageOptionsHash, expectedRevision; серверная матрица переходов и актуальные права |
| connectionStatus / registerBinding / disableBinding | Привязка к transport account, capabilities/health; отключение сохраняет историю |
| startImport / importStatus / pauseImport | Утверждённый источник/диапазон и checkpoint; отдельное право администратора |

Безопасность нельзя обеспечить только этими командами: существующие generic record mutations должны запрещать обход переходов/состояний/системных полей. AI/workflow tools вызывают те же domain services с инициатором, а не обходят их raw SQL или unrestricted application token.

Subscription выдаёт только разрешённые conversation events; при изменении прав переавторизация и остановка дальнейшей выдачи. После reconnect клиент передаёт cursor, при разрыве retention получает явную необходимость перечитать разрешённый snapshot. Скрытый диалог не раскрывается даже идентификатором/preview в общей ленте.

## Connector -> Twenty: входящие и квитанции

Предлагаемый внутренний HTTP endpoint принимает версионированный envelope:

```json
{
  "schemaVersion": 1,
  "eventId": "stable-source-event-id",
  "accountBindingId": "binding-id",
  "routeGeneration": 1,
  "kind": "message.received",
  "providerChatId": "opaque-provider-id",
  "providerMessageId": "opaque-provider-id",
  "occurredAt": "provider-timestamp",
  "payload": {}
}
```

`workspaceId`, actor и полномочия выводятся из аутентифицированной привязки; входящий payload не выбирает их. Для каждого binding — ограниченный credential, подпись тела с timestamp и проверкой replay window; TLS, ротация и отзыв ключа. Стабильный eventId обеспечивает безопасные повторы после transport timeout. Ключи не доступны браузеру/ИИ. Параметры окна, лимитов и rotation фиксируются при реализации, не считаются настроенными.

Ответ после durable receipt: accepted + receiptId; повтор того же payload — тот же receiptId. Неверная подпись/отозванное поколение — отказ; ID с изменённым payload — conflict; перегрузка — retryable отказ до ACK. Kind имеет отдельную schema: received/edited/deleted, command.receipt, connection.state. Не доверять присланным полям actor/admin, URL для скачивания или relationship IDs.

Поле origin запрещено во внешнем envelope. Trusted history_import назначает только внутренний import job после pull страницы по scoped history.read credential; источник не управляет suppression. Omni generic record events полностью подавлены. Safe projection из DomainEvent поступает в типизированный OMNICHANNEL_EVENT workflow trigger по implementation-spec §15.10, не в общий WorkspaceEventBatch.

## Twenty -> Connector

Полный контракт history pull, envelope schema и страницы — implementation-spec §15.16. `fetchHistoryPage(importBatchId,binding,chat,sourceType,cursor,window,limit,expectedAccountIdentity)` использует отдельный history.read credential без права send. Происхождение назначает внутренний job Twenty; сохранение page receipt предшествует cursor advance.

Минимальные операции: enqueue(commandId, binding, routeGeneration, providerChatId, payload/files), commandStatus(commandId), accountStatus(binding), pauseAccount(binding), cancelCommand(commandId). Это адаптация существующего enqueue_send/jobs/Partner API, не заявление об их текущей совместимости.

commandId обязателен и стабилен; повтор с тем же телом возвращает прежнее задание, с другим — conflict. Credentials серверные, scopes ограничивают workspace/bindings. Connector проверяет владение маршрутом и поколение перед вызовом адаптера. Результат enqueue подтверждает сохранение, а не доставку.

Файлы выдаются адресно transport-команде; сервер не скачивает произвольный URL из сообщения без allowlist/SSRF-проверок, ограничений размера/типа и таймаутов. Для внешних вложений сохранить существующие media-защиты адаптеров и проверить их в новом пути.

## ИИ и workflow

- Trusted execution scope: workspace, conversation, initiating actor/application, policyVersion, automationEpoch, permitted account. Не содержится в редактируемом пользователем prompt.
- Tools: чтение разрешённой CRM/knowledge, CRUD в разрешённой области, workflow start, send via CommandService, internal note, takeover/escalate. Конкретные разрешённые инструменты — настройки роли/агента; инфраструктурные и credential-management операции не выдаются клиентскому AI по умолчанию.
- Для общих CRM tools требуется тот же scope на query/mutation/export; не ограничиваться только новым send tool. При передаче через разрешённую очередь/дочернее исполнение scope и полный covered admission set восстанавливаются из trusted reference. Произвольные logic function/CODE/HTTP под omni reference запрещены по design/09; generic token не выпускается.
- Knowledge retrieval фильтрует workspace/resource ACL до формирования prompt. Вложения/текст клиента не переопределяют инструкции и выбор tools. Scope меняется — старый AI-контекст инвалидируется.
- Workflow action «Отправить в диалог» идёт через тот же send contract. Event consumers передают causation/origin и не запускаются на импортированных записях.
- Существующий `sendInboxMessage` остаётся внутренним уведомлением сотрудникам; он не становится способом импорта клиентской истории.

## Ошибки и версионирование

Различать denied/not-found без раскрытия существования чужого ресурса; revision conflict; invalid input; unsupported capability; unavailable/retryable; outcome unknown. Client retry не меняет idempotencyKey. Переход несовместимого envelope — новая schemaVersion с явной проверкой поддержки; неизвестное событие сохраняется в карантин с причиной, не отбрасывается как успешно обработанное.

Omni-capable workflow независимо от trigger проходит governance до первого шага. WEBHOOK/MANUAL требуют idempotency key; same key/different hash — conflict. SEND_OMNI_MESSAGE без trusted reference запрещён. DATABASE_EVENT/CRON получают server source key, root/scope/budget по design/09; replay не сбрасывает ancestry.

setMode→auto возвращает pending_human_commands при pending/dispatching/accepted/outcome_unknown человеческих Commands (включая cancelRequested без доказанного terminal outcome). addInternalNote дедуплицируется UNIQUE(workspace,author,key) с payload hash; mismatch conflict. Stage/identity link/unlink меняют policyEpoch и invalidation контекста по spec §15.23.

Workflow ID на границе нормализуется из legacy alias в tenant-scoped canonical core ID до idempotency/intent lookup. Explicit deactivate/delete обновляет retained cancellationEpoch даже после ordinary publish; publish/archive не отменяет старые pinned intents. Source coverage/referenceRequired — spec §15.19 и decision-tables, не клиентское поле.

Отмена транспортной команды: cancelCommand(commandId) — idempotent, tenant/owner/generation scoped, durable tombstone действует и до enqueue. Только journal юзербота у provider boundary подтверждает cancelled либо too_late; недоступность/timeout = unresolved cancelRequested, не cancelled. Центральный ACK запроса отмены не доказывает provider outcome. Spec §15.3/15.7; поздний enqueue того же ID сверяет tombstone. Workflow cancellation refs в Command и отмена при explicit deactivate/delete — spec §15.19.

## Уточнения reply, связей и trusted provenance

Reply разрешён только на MessageLink того же workspace/conversation после текущей ACL-проверки и проверки capability. Сервер сохраняет immutable native reply reference; target и native snapshot включены в payloadHash. expectedControlEpoch — только CAS precondition и не входит в hash: конфликт до commit не занимает idempotency key; после commit тот же key/hash возвращает прежний Command после текущей авторизации. Недоступный/удалённый reply target и unsupported reply дают видимую ошибку, без тихой отправки без цитирования.

Transport payload передаёт outboundSequence и resolvedReplyNativeRef; очередь следует §4 implementation-spec. FIFO — порядок первого durable enqueue, не обещание порядка доставки/прочтения. Unknown acceptance предшественника блокирует автоматическое продвижение; known accepted journal proof сохраняется отдельно от последующего unknown provider outcome. Явный ручной replacesCommandId сохраняет старый unknown и предупреждает о возможном дубле/порядке.

Входящий внешний JSON не определяет origin или trusted actor. Provenance external_human / external_service / unresolved_external выводится только из квалифицированного журнала userbot и correlation, не из отсутствия commandId или текста. External service требует проверяемого service principal; правило G11 отдельно от externalHumanReplyPolicy, до выбора — pause/handoff. Такие outgoing не создают customer admission.

Non-message workflow до первого шага получает server-provided root.conversationId/route через G07 domain resolver по разрешённым ConversationTarget. Missing/multiple → deny; FIND_RECORDS не используется для core Conversation и клиент не может подменить trusted variable.

Explicit manager summarize/rephrase — read-only assist в любом mode; current manager∩agent ACL, AutomationArtifactScope, без Command/reply slot/mutating tools. Transport outboundSequence диагностический для connector, его unique key — commandId и порядок — durable journal; после restore применяются §15.25 fence/reconciliation, не reuse потерянных command IDs.

Human observedSequence — обязательный stale-view precondition, не payloadHash и не dispatch fence. Два одновременных ответа → первый commit/новый event cursor, второй stale_view; UI показывает изменения и получает явное подтверждение с новым cursor. Уже принятый key/hash возвращает ту же Command. Exact transaction/idempotency rules — spec §15.26. Explicit replacesCommandId не обходит FIFO: при неизвестном acceptance предшественника также waiting_predecessor.
