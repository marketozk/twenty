# Контракты API v1

Актуальные определения: [индекс владельцев](../plan/contracts/README.md). Этот документ описывает архитектуру/сценарии; точные контракты и schema находятся у указанных владельцев.

[Единый контракт автоматизации](09-automation-contract.md) определяет инструменты, stable workflow identity, pausing и общую квоту ответов. Текущий допуск и ограничения — [STATUS](../STATUS.md); проектируемые функции ещё не реализованы.

Ниже **проектируемые**, ещё не работающие операции. Публичные API Twenty сохраняются; новые команды используют те же session/workspace guards, а транспортные credentials имеют отдельную узкую область. Проверенные существующие точки расширения: APP channels/ingestMessages, messaging transaction services, AgentRunService и workflow executor.

## Браузер -> Twenty

GraphQL queries/mutations для команд и чтения; существующая инфраструктура authenticated subscriptions/SSE для обновлений. Нативный экран в twenty-front не ограничен fetch bridge SDK. Точное имя wire-операций фиксируется при schema generation; таблица определяет их назначение.

| Операция | Вход / эффект |
|---|---|
| conversations / conversationMessages | Фильтры, cursor, page limit; ACL применяется до выдачи, count и сумм |
| sendConversationMessage | conversationId, текст/готовые file IDs, replyToMessageLinkId nullable, idempotencyKey, expectedControlEpoch, observedReplyRevision (human); сервер назначает actor/workspace, создаёт Command |
| linkConversationTarget / unlinkConversationTarget | conversationId, objectMetadataId, recordId, expectedTargetRevision (0 для отсутствующего edge); current ACL обеих сторон, canonical core edge и native projection атомарно; повтор/stale правила spec §7 |
| addInternalNote | conversationId, body, idempotencyKey; не вызывает внешнюю отправку |
| assignConversation / changeParticipants | expectedControlEpoch, разрешённые workspaceMember IDs; проверка права назначения и доступа получателя |
| setConversationMode / takeover | mode, expectedControlEpoch; атомарное увеличение controlEpoch + automationEpoch и отмена pending non-human команд прежнего automationEpoch |
| transitionOpportunity | opportunityId, targetStageValue, expectedStageOptionsHash, expectedRevision; серверная матрица переходов и актуальные права |
| activateBinding / updateBindingDefaults | bindingId,defaultQueueId/defaultConversationMode/autoCreatePersonEnabled,expectedRevision,idempotencyKey; admin policy writer, gates/defaults/retry по spec §15.27 |
| createOmniQueue | bindingId,name,expectedRevision=0,idempotencyKey; admin policy writer, same-binding identity, grants отдельно до activation |
| manageTeam / manageTeamMember | create/update/delete, expectedRevision,idempotencyKey; active workspace membership и policy writer, без неявной выдачи grants |
| manageKnowledgeSource | sourceKind/id/version,visibilityPolicy,active,expectedRevision,idempotencyKey; current source ACL и protected artifact scope |
| transferBindingCustodian | bindingId,successorWorkspaceMemberId,expectedRevision,idempotencyKey; successor проверен, lifecycle §15.11, actor/audit сохранены |
| mapHistoricalAuthor | bindingId/sourceSystem/sourceAuthorId,verified workspaceMember target,HistoricalAuthorMapping.expectedRevision (0 при создании),idempotencyKey; явная audited mapping, immutable historical snapshot не переписывается |
| requestControlledPurge / purgeStatus | target scope,approved retention/G10,reason,idempotencyKey; отдельное admin permission, durable operation/ledger, queued не означает завершённое удаление |
| updateOmniQueue | queueId,name/active,expectedRevision,idempotencyKey; admin policy writer, nonempty/default queue disable запрещён по spec §15.27 |
| workflowScheduleGaps | workspace/workflow filter,cursor,limit; admin workflow permission и current ACL; DomainEvent schedule.gap, чтение не запускает replay |
| connectionStatus / registerBinding / disableBinding | Привязка к transport account, capabilities/health; отключение сохраняет историю |
| startImport / importStatus / pauseImport | Утверждённый источник/диапазон и checkpoint; отдельное право администратора |
| closeConversation / reopenConversation | expectedControlEpoch; [status contract](../plan/contracts/access-control.md#closed-status) |
| claimConversation / moveConversationQueue | queueId, expectedControlEpoch; server authorization и [queue schema](../plan/implementation-spec.md#3-схема--rob-764), policy fence |
| cancelOwnCommand | commandId, idempotencyKey; current author/explicit cancel permission; [remote cancellation](../plan/implementation-spec.md#157-коннектор-схема-состояние-эхо-и-поколения), ACK запроса не send outcome |
| sendConversationMessage (manual replacement) | replacesCommandId дополнительно к обычному входу; [Command/FIFO](../plan/contracts/sending-ui.md#command-admission) |
| linkExternalIdentity / createPersonForIdentity | identityId, targetPersonId или разрешённые поля Person, expected revision, idempotencyKey; [identity/lifecycle](../plan/implementation-spec.md#152-идентичность-источника-контакта-и-внешнего-автора) |
| requestExecutionReplay | source execution, reason, idempotencyKey; [ReplayRequest schema](../plan/implementation-spec.md#3-схема--rob-764), отдельное разрешение и предупреждение об эффектах |
| resolveCommandOutcome | commandId,evidenceRef,idempotencyKey; отдельное право и [серверная проверка evidence](../plan/contracts/sending-ui.md#outcome-resolution), без ручного terminal override |
| startOmniWorkflow | coreWorkflowVersionId,idempotencyKey,payload; [governed MANUAL ingress](../plan/contracts/workflow-execution.md#manual-editor-ingress), server root/run ID, опубликованная версия |
| markConversationRead | lastReadSequence, current conversation ACL; монотонный read cursor в ConversationReadCursor только для current workspaceMember; без изменения участия/epoch, [SSE/UI](../plan/contracts/sending-ui.md#ui) |
| summarizeConversation / rephraseDraft | conversationId, разрешённый input; явный [read-only assist](../plan/contracts/access-control.md#scope) |
| auditEntries / requestAuditExport / auditExportStatus | scope/filter/cursor; [audit contract](08-audit.md), current audit/field/data ACL до query/export |
| updateResourceGrants / updateQueueGrants / updateStageRules / updateAutomationPolicy | admin policy-management permission, expectedRevision, idempotencyKey; [policy writers](../plan/contracts/access-control.md#policy-writers), атомарный audit |


Безопасность нельзя обеспечить только этими командами: существующие generic record mutations должны запрещать обход переходов/состояний/системных полей. AI/workflow tools вызывают те же domain services с инициатором, а не обходят их raw SQL или unrestricted application token.

Subscription выдаёт только разрешённые conversation events; при изменении прав переавторизация и остановка дальнейшей выдачи. После reconnect клиент передаёт cursor, при разрыве retention получает явную необходимость перечитать разрешённый snapshot. Скрытый диалог не раскрывается даже идентификатором/preview в общей ленте.

## Connector -> Twenty: входящие и квитанции

LOG-026 реализует внутренний receipt service; HTTP endpoint ещё не подключён.
Единый контракт и ограничения первой текстовой порции: [envelope v1](../../../packages/twenty-server/src/modules/omnichannel/contracts/README.md),
[JSON Schema](../../../packages/twenty-server/src/modules/omnichannel/contracts/omni-incoming-envelope-v1.schema.json).
Иллюстрация (полный набор правил задаёт schema):

```json
{
  "schemaVersion": 1,
  "eventId": "stable-source-event-id",
  "accountBindingId": "09162094-e768-4b4d-bd73-3d52fb4ba660",
  "routeGeneration": "1",
  "kind": "message.received",
  "providerChatId": "opaque-provider-id",
  "providerMessageId": "opaque-provider-id",
  "occurredAt": "2026-10-27T10:00:00Z",
  "sourcePosition": {"type": "adapter-defined", "value": "opaque-position"},
  "sourceVariant": "complete",
  "direction": "incoming",
  "nativeMessageKeyVersion": 1,
  "payload": {"text": "Тестовое сообщение", "sourceAuthorId": null, "sourceDisplayName": null}
}
```

`workspaceId`, actor и полномочия выводятся из аутентифицированной привязки; входящий payload не выбирает их. Для каждого binding — ограниченный credential, подпись тела с timestamp и проверкой replay window; TLS, ротация и отзыв ключа. Стабильный eventId обеспечивает безопасные повторы после transport timeout. Ключи не доступны браузеру/ИИ. Параметры окна, лимитов и rotation фиксируются при реализации, не считаются настроенными.

Ответ после durable receipt: accepted + receiptId; повтор того же payload — тот же receiptId. Неверная подпись/отозванное поколение — отказ; ID с изменённым payload — conflict; перегрузка — retryable отказ до ACK. Первая реализованная schema поддерживает message.received/edited/deleted; command.receipt и connection.state пока отвергаются и требуют отдельного будущего контракта. Не доверять присланным полям actor/admin, URL для скачивания или relationship IDs.

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

Семантика операций: [workflow-execution — design-24](../plan/contracts/workflow-execution.md#design-24).

setMode→auto возвращает pending_human_commands при pending/dispatching/accepted/outcome_unknown человеческих Commands (включая cancelRequested без доказанного terminal outcome). addInternalNote дедуплицируется UNIQUE(workspace,author,key) с payload hash; mismatch conflict. Stage/identity link/unlink меняют policyEpoch и invalidation контекста по spec §15.23.

Семантика операций: [workflow-execution — workflow-ids](../plan/contracts/workflow-execution.md#workflow-ids).

Отмена транспорта cancelCommand(commandId): [provider boundary и tombstone, spec §15.7](../plan/implementation-spec.md#157-коннектор-схема-состояние-эхо-и-поколения). Отмена workflow: [lineage](../plan/contracts/workflow-execution.md#command-cancellation).

## Уточнения reply, связей и trusted provenance

Семантика операций: [sending-ui — reply](../plan/contracts/sending-ui.md#reply).

Семантика операций: [sending-ui — fifo](../plan/contracts/sending-ui.md#fifo).

Входящий внешний JSON не определяет origin или trusted actor. Provenance external_human / external_service / unresolved_external выводится только из квалифицированного журнала userbot и correlation, не из отсутствия commandId или текста. External service требует проверяемого service principal; правило G11 отдельно от externalHumanReplyPolicy, до выбора — pause/handoff. Такие outgoing не создают customer admission.

Семантика операций: [workflow-execution — design-49](../plan/contracts/workflow-execution.md#design-49).

Семантика операций: [access-control — scope](../plan/contracts/access-control.md#scope).

Семантика операций: [sending-ui — human-stale-view](../plan/contracts/sending-ui.md#human-stale-view).


### Администрирование webhook

createOmniWebhookBinding / rotateOmniWebhookCredential / revokeOmniWebhookCredential требуют admin policy-management permission, expectedRevision и idempotencyKey; секреты выдаются только при создании. Signed POST ingress и ограничения определены единственным [webhook-auth](../plan/contracts/workflow-execution.md#webhook-auth); legacy public endpoint для governed flow не используется.

Административные idempotency/CAS и lost-secret response — [единый writer](../plan/contracts/access-control.md#policy-mutation). updateAutomationPolicy публикует [immutable version](../plan/contracts/access-control.md#automation-policy-version), а не изменяет settings принятого root.
