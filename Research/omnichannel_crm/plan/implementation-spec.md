# Подробная спецификация реализации — весь проект

26.10.2026, уточнение 27.10.2026. Нормативный план этапов1–7; реализация ROB-764 продолжается, подтверждённые результаты и оставшиеся границы — в [журнале](../DEVLOG.md). Pinned Twenty729f6236126eddaa68d176fb766bc349b19de11d. Разделы с перенесёнными правилами сохраняют ссылки; нормативные владельцы указаны в [индексе контрактов](contracts/README.md).

Контракт: [требования v0.6](../requirements.md), [потоки](../design/02-behavior.md), [модель](../design/05-models.md), [API](../design/06-api.md), [аудит](../design/08-audit.md). Доказательства по коду: [integration-map](../implementation/integration-map.md), [транзакции](../implementation/transactions-audit-source.md), [доступ](../implementation/access-source.md), [ИИ/workflow](../implementation/ai-workflow-source.md), [коннекторы](../research-connectors.md).

Конечные таблицы событий/прав/Command lifecycle: [decision-tables.md](decision-tables.md). Абстрактная проверка таблиц отделена от runtime-тестов.

## 1. Границы и модель отказов

Полная замена SaleBot для общения: Telegram/MAX через отдельные юзерботы, совместный inbox менеджеров, CRM-права, аудит, автоответы/действия ИИ, workflow и импорт. Нет интеграции с тендерным роботом или обхода Enterprise gate. Внешние группы мессенджеров и дополнительные Bot API аккаунты не считаются выбранными; совместная работа менеджеров обязательна.

Модель отказов для review: concurrent duplicate/reordered events; crash процесса в любой точке; недоступность одной зависимости; timeout/потеря ответа; Redis loss при сохранной PostgreSQL; revoke/takeover/import-live race; восстановление известного backup с reconciliation. Одновременная утрата данных и всех копий, захват root или ложь провайдера вне гарантии. При неизвестном исходе внешнего send — unknown, не обещание exactly-once доставки.

Один существующий экземпляр CRM. Постоянные automated tests используют временную БД/namespace/storage с проверкой имени/адреса до reset. Это не второй постоянный экземпляр и не предварительный выбрасываемый прототип. Отказ от нового backup при выполненном обновлении не означает отказ от будущей защиты клиентских данных.

Различаем: факты существующего кода; решения плана; результаты тестов новой реализации. Наличие определения здесь не подтверждает готовность реализации; результаты проверок привязаны к коду в DEVLOG. Продуктовые настройки остаются gates раздела 13; не выдаём fixtures за реальные роли/аккаунты пользователя.

## 2. Модули и файлы

`server/` = `packages/twenty-server/src/`, `front/` = `packages/twenty-front/src/`. Новые пути ниже проектируемые. Existing symbols подтверждены source reports, перед patch повторно читаются call sites и ближайшие тесты.

| Область | Новые пути | Existing integration |
|---|---|---|
| Служебная схема (аудит — отдельная защищённая схема той же БД) | server/engine/core-modules/omnichannel-storage/{entities/,services/} | core.datasource.ts glob; fork-only manifest/runner §15.5, без регистрации в upstream sequence |
| Домен общения | server/modules/omnichannel/{omnichannel.module.ts,services/,controllers/,resolvers/,jobs/,types/} | MessagingSaveMessagesAndEnqueueContactCreationService, scope-aware messaging helpers |
| Права | server/engine/core-modules/crm-access/{entities/,services/,query/,types/}; conversation-access adapter | WorkspaceRepository, отдельные search/export/files/SSE paths |
| Аудит | server/engine/core-modules/crm-audit/{entities/,services/,resolvers/}; front/modules/crm-audit/ | ORM mutation kernels, metadata QueryRunner, UserSessionService |
| UI чатов | front/modules/omnichannel/{pages/,components/,hooks/,graphql/,types/} | Навигация, Twenty UI, Lingui, session guards |
| ИИ/процессы | server/modules/omnichannel/{ai/,workflow/} | AgentRun/turn, ToolContext/Executor, record CRUD, workflow context/trigger listener |
| Транспорт | integrations/messaging/{contracts/,connector/,adapters/,tests/} | Отобранные C/H/M файлы с SHA/лицензиями; секреты/сессии не копируются |
| Эксплуатация | ops/omnichannel/ | Полный Git snapshot/image + актуальный конфиг, secrets отдельно |

Одна domain service на команду; controller/resolver/job/tool не дублируют SQL. Регистрация Nest providers в app/worker/command проверяется по DI graph; worker не требует HTTP server. Shared — только типы/константы, без server imports или credentials.

## 3. Схема — ROB-764

Все служебные entities имеют id UUID, workspaceId NOT NULL, createdAt/updatedAt timestamptz. Own composite FK включают workspaceId. Ссылки на динамические workspace records проверяются сервером на workspace/soft-delete; существующий FK не выдумывается. Provider IDs — text, не JS number. Служебные таблицы не регистрируются в objectMetadata/generated CRUD. Каждый SQL явно tenant-scoped.

| Entity | Обязательные данные сверх общих | Constraints / indexes |
|---|---|---|
| CrmAuditEntry | eventKey,operationId,attemptId nullable,actor/initiator,action,resourceKind/id,outcome,reasonCode,redactedDiff,payloadHash,securityDescriptor,correlation/causation | UNIQUE(workspaceId,eventKey); immutable payload hash; crm_audit schema, no cascading workspace FK; dedup semantics §15.27 |
| AdminDeletionLedger | operationId,recordKind,workspaceId (historical),actor,manifestHash,evidenceHash,outcome,timestamp | UNIQUE(operationId,recordKind,evidenceHash); crm_audit append-only; workspaceId is historical descriptor, no cascade FK; new immutable record per progress/outcome |
| ForkMigrationLedger | migrationId,checksum,status,appliedAt | instance-wide core ledger: UNIQUE(migrationId), no workspaceId; migrator-only, advisory lock; §15.5/15.19 |
| PolicyMutationReceipt | actorKind/actorId,idempotencyKey,operationId,action,resourceDescriptor,payloadHash,resultPublic,committedAt | UNIQUE(workspaceId,actorKind,actorId,idempotencyKey); no secrets; same transaction as mutation/audit, [writer](contracts/access-control.md#policy-mutation) |
| AutomationPolicy | bindingId,currentVersion nullable,revision bigint | UNIQUE(workspaceId,bindingId), UNIQUE(workspaceId,id); binding is route scope; [versions](contracts/access-control.md#automation-policy-version) |
| AutomationPolicyVersion | policyId,version bigint,settings jsonb,settingsHash,publishedBy, publishedAt | UNIQUE(workspaceId,policyId,version); immutable settings/scope, FK to AutomationPolicy; no secret values; retained while referenced |
| AccountBinding | platform, connectorInstanceId/accountId, connectedAccountId, messageChannelId, routeGeneration bigint, revision bigint, status, capabilitiesVersion/json, defaultQueueId nullable, defaultConversationMode=human, autoCreatePersonEnabled=false | UNIQUE(workspaceId,platform,connectorInstanceId,accountId), UNIQUE(workspaceId,messageChannelId), generation>0; transport registry дополнительно запрещает двух владельцев аккаунта; defaultQueueId composite FK(workspaceId,bindingId,queueId) на OmniQueue, required for active binding; §15.27 |
| ExternalIdentity | bindingId, providerPeerId, personId nullable, verificationSource, revision bigint | UNIQUE(workspaceId,bindingId,providerPeerId); username не ключ |
| Conversation | bindingId, providerChatId, messageThreadId, assigneeMemberId nullable, status, mode, conversationSequence bigint=0, replyRevision bigint (human stale-view), queueId nullable, controlEpoch bigint (CAS управления), automationEpoch bigint (fence mode/takeover), nextOutboundSequence bigint, policyId/policyVersion | UNIQUE(workspaceId,bindingId,providerChatId); index workspace/assignee/status/updatedAt |
| ConversationMember | conversationId, workspaceMemberId | UNIQUE(workspaceId,conversationId,workspaceMemberId); участие не заменяет grant |
| ConversationReadCursor | workspaceId, conversationId, workspaceMemberId, lastReadSequence bigint | UNIQUE(workspaceId,conversationId,workspaceMemberId); composite FK(workspaceId,conversationId) только на core Conversation; dynamic workspaceMemberId проверяется сервером по общему правилу §3; личная отметка чтения, не участие и не grant; правило в [sending-ui](contracts/sending-ui.md#ui) |
| HistoricalAuthorMapping | bindingId,sourceSystem,sourceAuthorId,workspaceMemberId nullable,revision bigint,verificationEvidenceRef | UNIQUE(workspaceId,bindingId,sourceSystem,sourceAuthorId); mapping только явным admin writer, dynamic member server-validated; ROB-770; original message author snapshot неизменен |
| MessageLink | conversationId, bindingId, rawNativeMessageId, nativeMessageKey/version, messageId, currentRevisionId nullable (LOG077; legacy unknown), providerRevision/sourcePosition nullable, displayOccurredAt, displayTimeSource, outgoingCommandId nullable, immutableAuthorSnapshot jsonb, sourceAuthorId/sourceDisplayName/authorVerification nullable, senderProvenance, correlationState | UNIQUE(workspaceId,bindingId,conversationId,nativeMessageKey), UNIQUE(workspaceId,messageId); FK(workspaceId,id,currentRevisionId) → MessageRevision(workspaceId,messageLinkId,id), RESTRICT |
| IncomingReceipt | bindingId, eventId, kind/version/generation, canonicalPayloadHash, validatedEnvelope jsonb, trustedCaptureContext/jsonb и trustedCaptureContextHash nullable immutable pair, state, attempts, nextAttemptAt, leaseOwner/token/until, resultId/errorCode, applicationResult nullable versioned outcome (LOG078 storage/parser; LOG079 qualified writer); applied message receipt.resultId = canonical MessageLink ID | UNIQUE(workspaceId,bindingId,eventId); index state/nextAttemptAt/leaseUntil |
| OutgoingCommand | conversationId, actorKind/id, initiatingActorId, idempotencyKey, payloadHash/jsonb, expectedAutomationEpoch (non-human)/policyId/policyVersion/generation, createdRestoreIncarnation nullable (legacy unknown; server-captured immutable UUID), workflowCancellationRefs, senderClass/contentProvenance, producerTurnId/capturedTurnFence nullable, referenceId nullable (required non-human), cancelRequestedAt/cancelReason/cancelEvidence nullable, replacesCommandId nullable, outboundSequence, replyToMessageLinkId nullable, resolvedReplyNativeRef nullable, state, connectorJobId, connectorAcceptedEvidence/journalSequence nullable (monotonic), leaseToken/until, nextAttemptAt, statusRevision | UNIQUE(workspaceId,actorKind,actorId,idempotencyKey); UNIQUE(workspaceId,conversationId,outboundSequence); id=commandId; target/payload/reply native snapshot immutable  partial index(workspaceId,policyId,policyVersion,state,id) WHERE senderClass != human; |
| DomainEvent | eventId=id, conversationId nullable, kind, origin, causation/rootExecutionId, conversationSequence, payloadVersion/jsonb | UNIQUE(workspaceId,conversationId,conversationSequence) для conversation events |
| CommandResolutionRequest | commandId,actorKind/id,idempotencyKey,evidenceRef,evidenceHash,payloadHash,state,resultReceiptId nullable,leaseUntil nullable,reasonCode | UNIQUE(workspaceId,actorKind,actorId,idempotencyKey); immutable command/evidence intent; queued/checking/resolved/unresolved/denied; same key/hash returns same request; no status override |
| ConsumerReceipt | eventId, stable consumerId, pinnedVersionId, executionId, runIntentId nullable, referenceId nullable (required governed consumer), state, attempt, leaseToken/until, nextAttemptAt | UNIQUE(workspaceId,eventId,consumerId); workflow consumerId основан на workflowId, не версии; executionId неизменен при retry |
| BindingConfigWakeup | eventId,bindingId,handlerVersion=1,state=pending/running/retryable/completed/blocked,attempts,leaseOwner/token/until,nextAttemptAt,cursorNextAttemptAt/cursorReceiptId nullable pair,needsRescan=false,observedRouteGeneration nullable,errorCode nullable | UNIQUE(workspaceId,eventId); composite FK на DomainEvent и AccountBinding RESTRICT; due index(workspaceId,bindingId,state,nextAttemptAt); running iff lease pair present, token>0; counters nonnegative, generation positive; errorCode closed: binding_inactive/unsupported_handler/rescan_required/transient_failure; delivery semantics §15.27 |
| OmniRootExecution | rootKind/rootId, sourceKey, initialEventIds uuid[] immutable, scope, causation/coveredRoots, policyId/policyVersion, maxCrmEffects,maxHops,usedCrmEffects=0,usedHops=0, state | UNIQUE(workspaceId,rootKind,sourceKey), UNIQUE(workspaceId,rootKind,rootId); initialEventIds фиксируются при root creation вместе со всеми initial plans/events в одном commit; index(workspaceId,policyId,policyVersion,state,id); message и non-message governance по design/09 |
| OmniRootBudgetCharge | rootKind,rootId,chargeKind(crm_effect/hop),stableChargeKey,cost,executionRef | UNIQUE(workspaceId,rootKind,rootId,chargeKind,stableChargeKey); composite FK to OmniRootExecution; immutable successful charge, [root budget](contracts/workflow-execution.md#root-effect-budget) |
| EventDispatchPlan | eventId, rootKind/rootId (rootAdmissionId для message), immutable targets/versions, policyId/policyVersion, initialPlan boolean, state (включая empty) | UNIQUE(workspaceId,eventId), UNIQUE(workspaceId,id); tenant composite FK rootKind/rootId → OmniRootExecution; initialPlan server-only и eventId обязан входить в immutable root.initialEventIds; план и target receipts создаются атомарно с admission |
| OmniWebhookBinding | coreWorkflowId,principalKind/id,allowedResourceScope,active,revision | UNIQUE(workspaceId,coreWorkflowId,id); tenant binding, actor configured by admin/current grants, not payload |
| OmniWebhookCredential | webhookBindingId,keyId,encryptedSecretRef,status,notBefore,expiresAt nullable | UNIQUE(workspaceId,webhookBindingId,keyId); rotation/revoke under policy fence, never public/AI-readable |
| OmniWorkflowSubscription | coreWorkflowId, activeCoreVersionId nullable, governedMarker, triggerType/filter, enabled, cancellationEpoch, tombstone, scheduleRevision, scheduleSnapshot(rule/timezone/activeFrom), lastPlannedOccurrence nullable, pendingGapEventId nullable | UNIQUE(workspaceId,coreWorkflowId); retained epoch не сбрасывается при publish/reactivate |
| EventCoverageRegistry | objectMetadataId, eventKind, referenceRequired, coverageVersion | UNIQUE(workspaceId,objectMetadataId,eventKind); sticky requirement после governed activation |
| OmniReplyBudget | rootKind, rootId, policyId/policyVersion, maxReplies | UNIQUE(workspaceId,rootKind,rootId); captured policy соответствует root; общая квота agent/workflow/descendants хранится и при maxReplies=0 без slots; [владелец контракта](contracts/workflow-execution.md#design-29) |
| OmniReplySlot | rootKind, rootId, replySlot, producerKind/producerId, commandId, effectRef, payloadHash, state=bound | UNIQUE(workspaceId,rootKind,rootId,replySlot); tenant FK на budget и Command; один Command может занимать slots нескольких covered roots; атомарное связывание и проверка общей квоты — writer, не предварительная резервация до LLM |
| RouteActivation | bindingId, activationVersion, sourcePositionType, boundary jsonb | UNIQUE(workspaceId,bindingId,activationVersion); immutable boundary |
| AutomationAdmission | bindingId, conversationId, messageLinkId, effectKind=customer_inbound (единственное v1 значение), activationVersion, trustedSourcePosition, eventId | UNIQUE(workspaceId,bindingId,messageLinkId,effectKind); activationVersion — captured provenance, не новый dedup key; conversationId служит составным FK к MessageLink и Event того же диалога |
| InternalNote | conversationId, authorMemberId, body, idempotencyKey, payloadHash | UNIQUE(workspaceId,authorMemberId,idempotencyKey); same key/different conversation/body hash → conflict, retry возвращает ту же note; без transport |
| AttachmentLink | conversationId, messageId XOR commandId, fileId nullable, providerAttachmentId, state/hash/error | Ровно один родитель; уникальность provider attachment в родителе |
| ImportBatch | bindingId, sourceType/snapshotRef/range, checkpoint/counts jsonb, state, generation/activationVersion | Checkpoint после durable ACK страницы; secrets вне batch |
| ImportPageReceipt | batchId, requestCursorKey, responseHash, nextCursor, sourceSnapshot/version, state, itemCount | UNIQUE(workspaceId,batchId,requestCursorKey,responseHash); начальный cursor имеет canonical non-null sentinel; cursor advance только после applied всех items |
| ImportPageItem | pageReceiptId, itemOrdinal, payloadHash/ref, incomingReceiptId nullable, state/error | UNIQUE(workspaceId,pageReceiptId,itemOrdinal); immutable captured payload и durable apply outcome |
| DurableHandoff | conversationId, producerKind/id, dispositionKey, unansweredRoots, reason, state, taskId nullable | UNIQUE(workspaceId,producerKind,producerId,dispositionKey); один handoff/outbox event в terminal transaction, повтор возвращает тот же ID; ACL conversation/queue, task optional projection |
| ReplayRequest | actorKind/id, idempotencyKey, payloadHash, sourceExecutionKind/id, reason, requestedScope, state, derivedExecutionId nullable | UNIQUE(workspaceId,actorKind,actorId,idempotencyKey); same key/different hash conflict; derivedExecutionId immutable; current auth и явное предупреждение о committed/uncertain effects |
| ConversationTarget | conversationId, objectMetadataId, recordId, active, revision, projectionId nullable | UNIQUE(workspaceId,conversationId,objectMetadataId,recordId); canonical explicit edge; dynamic record validation, soft unlink retains revision |
| WorkspacePolicyState | epoch bigint, restoreIncarnation UUID | UNIQUE(workspaceId); bootstrap before readers, primary only |
| Team / TeamMember | Team: name,revision bigint; TeamMember: teamId,workspaceMemberId,revision bigint | TeamMember UNIQUE(workspaceId,teamId,workspaceMemberId) |
| ResourceAssignment / ResourceGrant | resourceKind/id, principalKind/id, action, effect, revision bigint; assignmentKind(primary_owner/team), assignment owner/team | Grant UNIQUE(workspaceId,resourceKind,resourceId,principalKind,principalId,action); assignment UNIQUE(workspaceId,resourceKind,resourceId,principalKind,principalId,assignmentKind); partial UNIQUE(workspaceId,resourceKind,resourceId) WHERE assignmentKind=primary_owner, primary_owner requires workspaceMember; explicit deny dominates |
| StageRule | objectMetadataId,fieldMetadataId,optionValue,fromValue,toValue,principalKind/id,action,effect,revision bigint | UNIQUE(workspaceId,objectMetadataId,fieldMetadataId,action,optionValue,fromValue,toValue,principalKind,principalId); read/edit: optionValue and wildcard from/to; transition: from/to and wildcard optionValue; configure: all wildcard; no NULL/wildcard ambiguity |
| OmniQueue | bindingId, name, active, revision | UNIQUE(workspaceId,bindingId,name); UNIQUE(workspaceId,bindingId,id) для composite queue FKs; tenant-scoped FK, Conversation.queueId с FK на очередь того же binding; отсутствие queueId означает private/unassigned, не общедоступную очередь |
| QueueGrant | bindingId,queueId,principalKind/id,action,effect,revision bigint | UNIQUE(workspaceId,bindingId,queueId,principalKind,principalId,action) |
| CrmRecordRevision | objectMetadataId,recordId,revision | UNIQUE(workspaceId,objectMetadataId,recordId); §15.17 |
| AutomationArtifactScope | artifactKind,artifactId,conversationId,referenceId,capturedResourceScope | UNIQUE(workspaceId,artifactKind,artifactId); protected aggregate parent set, §15.12 |
| OmniMessageRevision | messageLinkId,sourceRevisionKey,sourceEventId,contentHash,tombstone,origin,protectedPayloadRef nullable | UNIQUE(workspaceId,messageLinkId,sourceRevisionKey); UNIQUE(workspaceId,messageLinkId,id) supports current-head FK; metadata in ROB-764, payload/retention later |
| OmniExecutionReference | conversationId, policyId/policyVersion, initiatingPrincipalKind/id, applicationId nullable, agentVersionId nullable, automationEpoch, restoreIncarnation, policyEpoch, rootEventId, activationVersion, webhookBindingId/credentialKeyId nullable (required webhook lineage), capturedResourceScope (resource IDs + edge revisions), parentReferenceId nullable | UNIQUE(workspaceId,id); immutable server-only row; composite tenant FKs; parent scope may only narrow; current authorization still mandatory  index(workspaceId,policyId,policyVersion,id); |
| OmniAutomationTurn | conversationId,referenceId,stableTurnKey,responderId,coveredRoots,inputRange,policy/automation epochs,state,leaseFence,leaseOwner,leaseUntil,heartbeatAt,progressAt,terminalReason,preparedToolCalls/nextEffectOrdinal | UNIQUE(workspaceId,stableTurnKey); partial UNIQUE(workspaceId,conversationId) for active autonomous states; §15.3  index(workspaceId,referenceId,state,id); |
| OmniEffectLedger | executionKind,executionId,stableEffectKey,payloadHash,state,commandId/result,coveredRoots | UNIQUE(workspaceId,executionKind,executionId,stableEffectKey); root budgets remain separate common constraints, no quota via toolCallId |
| OmniWorkflowRunIntent | runId,coreWorkflowId,pinnedCoreVersionId,coveredRoots,referenceId,cancellation refs,executionFence,lease/progress,checkpoint,disposition,waitRegistration | UNIQUE(workspaceId,runId); stable identities design/09; independent of native-run retention  index(workspaceId,referenceId,disposition,id); |
| OmniWorkflowTargetClaim | rootKind,rootId,coreWorkflowId,runIntentId | UNIQUE(workspaceId,rootKind,rootId,coreWorkflowId); all covered roots atomically claimed |
| KnowledgeSource | sourceKind,sourceId,sourceVersion,visibilityPolicy,active,revision | UNIQUE(workspaceId,sourceKind,sourceId); no generic CRUD/public-by-default; referenced records/files keep current ACL |


Во всех automation schema rows policyId/policyVersion — composite tenant FK(workspaceId,policyId,policyVersion) к immutable AutomationPolicyVersion; это не ACL policyEpoch. Turns/effects наследуют version через свой immutable execution reference/covered roots, не через текущий head. Conversation хранит текущую version; её смена не переписывает captured refs/roots. У OutgoingCommand эта пара NOT NULL также для human: provenance текущего head (включая disabled v0), не дополнительное разрешение. Human dispatch не требует совпадения captured version с head; он проверяет актуальные права/правила human send. Точный version fence относится к non-human, а не к происхождению исходного текста.

Cleanup policy.changed выбирает Root/Command непосредственно по policyId/version/state, а Turn/RunIntent — bounded seek по immutable OmniExecutionReference(policyId,policyVersion,id) и затем indexed join по referenceId + state/disposition. У Turn/RunIntent отдельные policy columns не дублируются: authoritative tuple находится в immutable reference. Checkpoint/progress и повтор consumer идемпотентны; текущая terminal state перепроверяется до cleanup, full-table scan и отдельный массовый UPDATE conversations не нужны.

Mutable policy entities AccountBinding, ExternalIdentity, Team/TeamMember, ResourceAssignment/Grant, QueueGrant, StageRule, OmniQueue, KnowledgeSource, OmniWebhookBinding, AutomationPolicy и HistoricalAuthorMapping имеют server-managed revision bigint, начальное значение1. Административные API ожидают expectedRevision этой строки; создание ожидает0/отсутствие, удаление проверяет последнюю revision. Все domain/generic/import/lifecycle writers этих строк bump revision в том же commit; UUID не переиспользуется. Conversation controls сохраняют отдельный expectedControlEpoch; native Opportunity — CrmRecordRevision. CAS не заменяет policy fence/authorization. PolicyMutationReceipt вводится ROB-764 для собственных mutations и расширяется ROB-766/769; Минимальные AutomationPolicy/Version schema и disabled bootstrap v0 входят ROB-764 вместе с OmniRootExecution; v0 фиксирует отсутствие автономии и нулевые budgets без выбора G04–G07 за пользователя. Binding и v0 создаются атомарно; ранние roots/dispatch захватывают v0 и не переактивируются после смены head. ROB-769 реализует full policy publish/validation, root effect/hop charges и governance activation. Test-only fixtures задают явную synthetic policy, не меняют production bootstrap.

WorkspaceMember — dynamic workspace record, не core FK target. ConversationMember, ConversationReadCursor и assigneeMemberId проверяют membership/workspace/soft-delete сервером под policy fence; composite FK допустим только на own core Conversation. Удаление WorkspaceMember по §15.11 немедленно лишает доступа, снимает его назначения/участие и удаляет личные read cursors через lifecycle writer; исторический автор остаётся immutable snapshot. Restore не восстанавливает grants/участие автоматически. Удаление только ConversationMember не удаляет WorkspaceMember и не создаёт права через оставшийся cursor.

Conversation.conversationSequence — отдельный монотонный счётчик apply/DomainEvent/UI, не controlEpoch/replyRevision и не provider chronology. Каждый conversation DomainEvent атомарно получает следующий номер под conversation lock; rollback откатывает счётчик и event, дубликат receipt не выделяет новый номер. Не-conversation events имеют NULL и не участвуют в этом UNIQUE. Unread/read-cursor используют этот порядок по sending-ui; timeline display order остаётся отдельным контрактом.

CrmAuditEntry/ForkMigrationLedger — ROB-764, AdminDeletionLedger — ROB-765 до разрешённого purge, OmniWebhookBinding/Credential и CRON checkpoint — ROB-769. Исключения общего workspace FK: audit/deletion rows сохраняют historical workspaceId без cascade, instance-wide migration ledger не имеет workspaceId.

CommandResolutionRequest вводится ROB-768; transport evidence применяется штатным идемпотентным receipt pipeline, не ручным UPDATE Command. OmniExecutionReference и обязательные reference FK для governed consumers/turns/non-human Commands вводятся ROB-769 до активации automation; ранние nullable columns не разрешают automation без reference. Reference retention не короче срока жизни ссылающихся intents/Commands/artifacts и replay evidence; удаление parent не разрешает расширять scope или реконструировать reference из текущих grants.

OmniQueue/Conversation.queueId вводятся ROB-764, QueueGrant — ROB-766; ImportPageReceipt/Item — ROB-770; DurableHandoff и ReplayRequest — ROB-769. Запрос на claim разрешён только для Conversation.queueId данного binding и подходящего queue grant; перенос между очередями — policy writer с UPDATE fence, controlEpoch++ и audit. Неизвестная/неактивная очередь не даёт доступ.

Таблица перечисляет логические entities, а не обещает одной миграцией включить все этапы. Минимальная WorkspacePolicyState и её bootstrap/lock protocol вводятся ROB-764 для атомарного ingress; полноценные own Policy/Grant/Stage/ArtifactScope/CrmRecordRevision вводятся ROB-766, ExecutionReference/Turn/Effect/RunIntent/Knowledge — ROB-769, ранние target/reference IDs и MessageRevision согласуются уже в ROB-764. ConsumerReceipt — доставка одного event одному consumer; OmniWorkflowRunIntent — общий durable запуск. Это разные таблицы: conversation.created и message.received одного root могут иметь два receipts, ссылающихся на один intent. TargetClaim дедуплицирует root+workflow до version, receipts не создают второй run; T14 проверяет этот пример.

InternalNote/Attachment/Import можно мигрировать в своих этапах, но идентификаторы контрактно согласованы сейчас. Базовая схема и writer CrmAuditEntry для собственных mutations входят в ROB-764. ROB-765 расширяет покрытие CRM, ROB-767 добавляет чтение/UI; первый этап не ждёт своего будущего audit dependency.

SQL/up/down первоначально генерируются штатным database:migrate:generate, затем изолируются в fork-only registry по §15.5; одного нового timestamp в 2-52 недостаточно. Upstream cursor не изменяется. Tests: пустая/заполненная fixture, повтор upgrade, down на пустых новых таблицах. Down непустых operational tables не выполняется автоматически. Additive schema, без backfill старых email и автоматического изменения существующих каналов; объёмная миграция существующей таблицы требует отдельной проверки lock time.

## 4. Приём и отправка — ROB-764/768

Проектируемые transport endpoints: POST /v1/omnichannel/events, GET /v1/omnichannel/receipts/:id. Browser — domain GraphQL из design/06-api. Envelope v1: eventId, accountBindingId, routeGeneration, kind, providerChatId/messageId, occurredAt, sourcePosition(type,value), payload. Import job вызывает внутренний service; внешний JSON не назначает workspace/actor/personId/policy/import origin.

Binding credential: keyId + HMAC SHA-256(method,path,timestamp,raw-body hash), constant-time compare, configured timestamp window/body limit. Replay старого события подписывается заново текущим timestamp, eventId сохраняется. Ключ — encrypted secret/reference, rotation overlap ограничен, revoke блокирует новые запросы. Limiting credential/workspace/global queue; 429/503 до ACK, Retry-After. Неизвестная schemaVersion/слишком большой body отклоняются до ACK. Поддержанная версия с необработанным kind может быть durable quarantined с явным статусом. Hash семантического валидированного envelope включает kind/target/generation, исключает transport signature/timestamp.

Ingress: validate/auth → transaction lock WorkspacePolicyState FOR SHARE → binding/generation (общий порядок §15.9) → INSERT receipt или сравнить hash при conflict → audit accepted → COMMIT → 202 receiptId/state. Одинаковый повтор возвращает тот же receiptId/current state (200); changed semantic payload=409, original receipt сохраняется. ACK означает ответственность CRM за replay, а не готовый Message. Отказ/неизвестный commit не даёт ложный ACK; клиент повторяет eventId.

Worker: короткий claim через FOR UPDATE SKIP LOCKED увеличивает leaseToken. После native ownership fence (§15.9) общая workspace transaction берёт WorkspacePolicyState в заранее выбранном SHARE/UPDATE режиме (§15.9/15.15), затем binding/conversation/identity и проверяет leaseToken/generation; затем scope-aware Message/participants + domain projection из ConversationTarget + link (matchParticipants/reconcile не вызываются; [repository-adapter](contracts/workflow-execution.md#repository-adapter)) + receipt applied + conversationSequence + admission/event + audit. Все writes через scope executor; injected independent repository запрещён. Второй worker после lease expiry может reclaim; старый token не может commit. Postcommit callback только ускоряет enqueue; durable job/event хранится в PostgreSQL.

Уточнение receipt lease lifecycle (LOG-027):

| Текущее состояние | Обычный claim |
|---|---|
| accepted / retryable_error | Только когда nextAttemptAt наступил |
| processing | Только после expiry, с увеличением leaseToken и attempts |
| blocked_config | Не выбирается; нужен отдельный проверенный config wake-up по §15.27 |
| applied / quarantined | Не выбирается |

Claim работает короткой отдельной транзакцией в scope workspace/binding текущего поколения; policy SHARE → binding SHARE → receipt SKIP LOCKED. Он не возвращает envelope и не означает применения сообщения. Batch ограничен 1–100, lease duration — 1–300 секунд, задаётся внутренним caller. Повторные claim/reclaim не меняют immutable envelope/hash/generation. Непринятые из-за старого поколения receipts сохраняются для отдельного reconciliation, без скрытого изменения capture generation.

Renew/defer — отдельные receipt-only транзакции с текущей авторизацией и проверкой active/current generation. После ожидания receipt row lock проверяются processing, точные owner/token/generation и expiry по clock_timestamp(), не времени клиента или началу транзакции. Stale owner не вправе ни продлить lease, ни очистить её/записать retry/error. Defer допускает retryable_error с bounded задержкой 1 секунда–24 часа, blocked_config либо quarantined с закрытым техническим reason-code catalog; lease очищается, receipt ID/hash/envelope сохраняются. Каждая committed transition имеет отдельный operationId и атомарный audit. Неопределённый COMMIT не объявляет transition успешным; после unknown claim worker не начинает apply по неподтверждённому владению, восстановление возможно по expiry/reclaim.

Эти операции не переводят receipt в applied и не вызывают произвольный projection callback под receipt lock. Будущий Message apply берёт родительские locks до receipt по общему протоколу и завершает реальный Message/link/event/audit одной транзакцией; receipt claim lock туда не переносится. Порядок wake-up, очереди и config recovery остаётся в §15.27.

Conversation upsert по binding/chat с последующим row lock. Unknown identity сохраняется unbound, без угадывания Person по имени; link/create Person — отдельная разрешённая команда. Fixture acceptance использует подтверждённую identity. Автосоздание контакта — отдельная настройка. Omni получает выделенный APP channel: прямой публичный ingestMessages в него запрещён, иначе upstream cache-lock path обойдёт links/receipts. Существующие обычные APP/email channels сохраняют контракт.
Реализация LOG080 принимает существующую ExternalIdentity с personId=null без создания/угадывания Person; LOG081 добавляет внутреннюю qualified registration с current authorization, actor-key receipt и retained success audit. LOG082 реализует внутренний explicit link/unlink/rebind с audited transitions, неизменным birth snapshot и атомарной invalidation старого Person target. LOG083 добавляет internal explicit target writer с natural-key CAS, manual projection, full retained audit proof и rollback. LOG084 реализует internal explicit CreatePerson atomic storage/audit с closed name allowlist; governed Person-created event/visibility остаётся ROB-769. LOG085 реализует opt-in live autoCreatePerson/internal config writer; import/restore/stale/edit/delete/placeholder не создают Person, применённый replay не создаёт повторно. Transport discovery остаётся ROB-768. Исторический author snapshot не должен переписываться будущей привязкой.

Определение: [sending-ui — command-admission](contracts/sending-ui.md#command-admission).

Определение: [sending-ui — command-states](contracts/sending-ui.md#command-states).

Определение: [sending-ui — reply](contracts/sending-ui.md#reply).

Определение: [sending-ui — fifo](contracts/sending-ui.md#fifo).

Определение: [sending-ui — echo](contracts/sending-ui.md#echo).

## 5. Durable events и import/live

Определение: [workflow-execution — design-19](contracts/workflow-execution.md#design-19).

Trusted history_import context подавляет business CREATED/UPDATED listeners до dispatch, включая штатный database workflow trigger. Audit не подавляется. UI projection и automation dispatch — разные consumers; импорт может обновить разрешённый UI без запуска ИИ/рассылки. Caller не присваивает suppression сам, omni-channel bypass закрыт.

Activation boundary — provider/source position, а не receivedAt. Адаптер задаёт сравнение; неизвестный порядок разрешает хранение, но блокирует auto effect до reconciliation. Import-first/live-first/parallel создают один Message и один допустимый live admission после boundary. Новая activationVersion не переигрывает старую историю автоматически. Под binding lock activation boundary продвигается только монотонно и не ниже high-watermark уже принятых admissions; несравнимые source position блокируют activation до reconciliation. UNIQUE admission в §3 не включает activationVersion: смена версии не создаёт второй customer root для прежнего MessageLink. Явный reprocess не вставляет новый automatic admission; явный reprocess имеет собственную команду/аудит. Own echo/internal note не получают admission входящего клиента. Causation/rootExecutionId и configured chain budget предотвращают loops; исчерпание общего reply/effect/hop budget даёт terminal budget_exhausted + один durable handoff по workflow-execution#root-effect-budget.

## 6. Аудит — ROB-765/767

Writer appendEntry(executor,trustedContext,safeChange) использует workspace scope либо core QueryRunner, никогда отдельный repository. Success+mutation один commit. Поля: actor/initiatingActor, action, resource, outcome/reason, operation/correlationId, policyVersion, previous/new revision, timestamp, allowlisted diff. Токены, session data, полный текст чатов/prompts, credential URLs не пишутся. Bulk пишет реально изменённые строки; CREATED+UPSERTED не создают два success одной операции.

Before-image под row lock/CAS, общий lock order; concurrency не должна записать ложное previous. При unknown commit lookup operationId прежде повтора. Denial после rollback — отдельная ограниченная транзакция и alert при её отказе. Logout/revoke не блокируется отказом audit; потеря аудита не маскируется как успешная запись.

Порции: A own mutations; B REST/GraphQL/direct ORM CRUD/merge/bulk; C metadata/roles в migration QueryRunner; D sessions; E agent/workflow definition/publish/run/tool; F files/import/connector lifecycle. Raw/bypass registry: caller,purpose,tenant,writer,test; неизвестный интерактивный bypass denied.

Append-only: app DB role SELECT/INSERT audit, без UPDATE/DELETE/TRUNCATE/ownership и наследования migrator. Отдельная migration owner role, preflight effective privileges. Retention роль отдельно после выбора срока; без решения очистка выключена, размер мониторится. Защита от root/superuser не обещается.

Query/UI/export применяют текущий ACL/field visibility до count/page. Deleted resource — сохранённый descriptor плюс текущая admin policy. Cursor(createdAt,id), bounded page, actor/action/outcome/resource/correlation filters. Export проверяет policy epoch на каждой странице и выдаче файла; export audit один, без рекурсии на каждую прочитанную audit row.

## 7. Права и сделки — ROB-766

Own core WorkspacePolicyState(epoch), Team/TeamMember, ResourceAssignment/Grant, StageRule. Workspace-scoped keys/FK; objectMetadata/fieldMetadata IDs, не имена custom объектов. Catalog защищённых объектов: Person/Company/Opportunity/omni, производные TimelineActivity/Note/Task/targets/Attachment по §15.6 и явно выбранные custom objects. Включение custom объекта требует покрытия его entry points.

Decision = ordinary object/field grants AND independent OwnBaselineReadabilityPolicy AND own row/action grants (§15.13); Enterprise record-share не используется как скрытый baseline oracle. Own deny сильнее allow; нет разрешения protected resource→deny. Assignment/share/team ограничены resource/actions; Person→Opportunity relation не расширяет доступ. Admin — явная роль workspace, не blanket bypass. Bootstrap grant создаётся отдельной audited операцией, self-grant через обычный API запрещён.

Определение: [access-control — read-authority](contracts/access-control.md#read-authority).

Canonical explicit conversation↔CRM edges хранятся в core ConversationTarget для всех зарегистрированных видов записей. MessageThreadTarget переиспользуется только как доменная projection для Person/Company/Opportunity (isManuallyAssigned=true, isAutomaticallyAssigned=false); Task/custom остаются в core и читаются domain API. Projection создаётся/удаляется в той же transactionScope с canonical edge, epoch и audit; она не второй источник прав. Native rematch/generic target CRUD для omni запрещены. Link/unlink принимают expectedTargetRevision (0 означает отсутствие edge), desired active и natural key. Сервер сначала проверяет текущие grants; при совпадении expected revision выполняет переход/revision++, при revision=expected+1 и том же desired active возвращает уже сделанный переход, при любом другом stale revision — conflict/refetch. Link/unlink доступны через собственные команды с текущими grants на conversation и target, UPDATE policy lock и policyEpoch++. У записи target есть active/revision: unlink soft, повтор того же desired transition возвращает существующий результат без второго audit, если revision доказывает отсутствие intervening mutation; иначе conflict/refetch, без слепого повтора. Уникальный natural key не допускает двух edges. Person target может соответствовать только текущей verified identity; изменение identity атомарно инвалидирует старый Person edge/projection. Target edge revision входит в captured scope: unlink/relink не делает старый LLM output снова действительным. Link не выдаёт прав на запись; обычные row/field/derived-parent ACL остаются обязательны. Merge/destroy/import используют тот же domain lifecycle для canonical edge и projection. T10/T13/T23: Task link, hidden record denial, link/unlink race, projection rollback, rebind во время LLM.

Predicate до select/filter/order/count/groupBy/pagination, root и joined aliases. Запрещённые поля не участвуют в поискe/сортировке; relation mask/NULL не раскрывает hidden label. Writes проверяют before eligibility и allowed after; stable locks/CAS. Bulk target = разрешённый набор без раскрытия скрытых IDs; адресный hidden target даёт единый denied/not-found контракт. Scope сохраняется и при nested/merge/direct ORM.

Stage validator общий для transitionOpportunity и generic API/tool/workflow/import пути. From/to по fieldMetadataId и SELECT optionValue, отдельные read/edit/transition/configure actions. Исторический import — узкий purpose, не allow-all. Hidden stages не дают labels/counts через другие views. Удаление stage требует миграции правил, unknown stage не разрешает переход.

Revoke transaction: lock policy row→изменить grant/assignment→epoch++→audit→durable invalidation. Будущие reads/mutations проверяют актуальный authoritative epoch; event-only cache invalidation недостаточна. SSE проверяет перед следующей выдачей, export — каждой страницей/скачиванием. Уже отправленные байты нельзя отозвать; UI очищает недоступное, но backend не зависит от UI.

Protected files: parent Message/Conversation/record ACL в FileByIdGuard и всех альтернативных FileController/presigned paths; browser authenticated proxy вместо долговременного capability URL. Revoke блокирует новый запрос, уже отданные байты не возвращает. Public assets отдельная классификация. Transport grant command/file/TTL/size, недоступен browser/AI.

Rollout: own policy не активируется до покрытия всех entry points и fixture matrix. Workspace activation с bootstrap grants одним административным шагом. Ошибка enabled policy→fail closed, не возврат к широким grants. SystemAuthContext без собственного purpose не bypass. Новые omni endpoints до этапа 3 недоступны реальным пользователям; DB tests этапа 1 изолированы.

## 8. Коннекторы и UI — ROB-768

Перед переносом C/H/M файлов из research-connectors повторно сверить SHA, license/notices и diff. Только транспортные модули и тесты, не live .env/session/cache. Разделить route registry, durable journal, provider adapters и destination Twenty. Контрактный test делает любой SaleBot HTTP вызов ошибкой: Twenty receive/send/history обязан пройти без него.

Registry — authoritative owner platform/account/chat route + generation. Enqueue проверяет credential scope/owner/generation и durable unique commandId+payload, возвращает stable jobId; status не зависит от UI Twenty. Capability matrix реальных ревизий: native idempotency, status lookup, echo correlation, text/media/reply/edit/delete/read/history/ordering. Неизвестное не равно supported. MAX без доказанной idempotency не повторяет неоднозначный RPC; Telegram проверяется на фактическое использование stable transport ID.

Handshake protocolVersion/capabilitiesVersion; несовместимость запрещает activation, без fallback в SaleBot. Revoked generation запрещает новые enqueue/send, но поздние квитанции по уже созданным commandId принимаются отдельным authenticated reconciliation path. Старый ключ не получает право на новый send ради приёма receipt.

Определение: [sending-ui — ui](contracts/sending-ui.md#ui).

Onboarding v1: binding/status/capabilities/reconnect-required; session secrets только в userbot. Встроенный QR/login либо внешняя панель — gate перед auth UI. До выбора можно реализовать transport contract/fake adapter, но нельзя объявить onboarding готовым.

## 9. ИИ/workflow — ROB-769

Определение: [workflow-execution — design-24](contracts/workflow-execution.md#design-24).

Tools, governance и roots: [workflow-execution — design-6](contracts/workflow-execution.md#design-6).

Определение: [workflow-execution — trusted-reference](contracts/workflow-execution.md#trusted-reference).

Определение: [access-control — scope](contracts/access-control.md#scope).

Определение: [access-control — takeover](contracts/access-control.md#takeover).

Определение: [workflow-execution — design-8](contracts/workflow-execution.md#design-8).

Определение: [workflow-execution — design-31](contracts/workflow-execution.md#design-31).

Определение: [workflow-execution — design-20](contracts/workflow-execution.md#design-20).

## 10. Файлы, edit/delete, история — ROB-770

Download через adapter: size limit до и во время stream, mime/extension policy, hash, filename normalization. Внешние URL: private/loopback/link-local/metadata deny, DNS/redirect проверки каждого hop. Internal authenticated storage — отдельный purpose. Quarantine/AV policy до выдачи; rejected media не теряет текст. Сеть не держит DB lock. Durable upload identity: metadata pending→object upload→DB finalize; crash восстанавливает по identity/hash, orphan cleanup отдельным journaled job.

Edit/delete сравнивает provider revision/source order; late create/edit не воскрешает tombstone. Несравнимый порядок→reconciliation, не incoming timestamp. Удалённый текст исключается из search/retrieval/AI context; audit хранит safe descriptor, а не полный текст. Tombstone не обещает удаление всех backup; физическое удаление/retention отдельная согласованная политика.

Import: source adapter SaleBot export/connector archive/native history, snapshot/range/accounts/version/capability check. Bounded page→durable receipts→checkpoint. Crash повторяет те же keys; batch ограничен bytes/messages, pause прекращает новые страницы. Source snapshot/generation/activation закреплены; смена источника — новый batch, не продолжение старого cursor.

Report: discovered/accepted/applied/duplicate/quarantined/missing-media, provider date range, gaps reasons, unbound identities. Completed — доступный выбранный диапазон, не обещание всей истории аккаунта. Import→live/live→import/parallel проверяются с включёнными AI и штатными workflow. Imported outgoing history не создаёт отправляемый Command.

## 11. Постоянные тесты

Ниже целевые группы приёмки и их владельцы; названия групп не обязательно совпадают с именами файлов. Expected задаётся контрактом. Реализованные PostgreSQL/native ORM группы ROB-764 и их результаты перечислены в [матрице приёмки](../implementation/rob764-acceptance.md); остальные группы остаются критериями следующих этапов. Наличие строки в этой таблице само по себе не означает выполненный тест.

| ID | Suite / задача | Оракул |
|---|---|---|
| T01 | ingress-idempotency.integration / 764 | 20 concurrent same events→1 receipt/message/link; changed hash=409, original неизменён |
| T02 | ingestion-atomicity.integration / 764 | Fault перед каждым write/commit: нет partial Message/targets/link/audit/applied; replay безопасен |
| T03 | claim-fencing.integration / 764 | После reclaim второй worker завершает; старый token не меняет результат |
| T04 | command-recovery.integration / 764/768 | Lost ACK/Redis/crash→тот же job/command; provider unknown не увеличивает provider calls |
| T05 | messaging-email-regression / 764 | Старый email/postcommit matching работает; обычный APP works; omni bypass denied |
| T06 | audit-atomicity.integration / 764/765 | Нет success после rollback; точный concurrent before/after; app role не UPDATE/DELETE/TRUNCATE audit |
| T07 | audit-redaction-query / 765/767 | Secret canaries не в audit/log/export; чужие IDs/counts отсутствуют; revoke блокирует download |
| T08 | access-entrypoints.integration / 766 | A/B/lead/admin/AI/app, 2 workspaces, CRUD/relations/search/order/filter/count/groupBy/export/SSE/files/tools соблюдают matrix |
| T09 | stage-transition.integration / 766 | Одинаковый validator domain/generic/tool/workflow; hidden stage не раскрывает labels/count |
| T10 | revoke-barrier.integration / 766/769 | Порядок revoke vs read/mutation соответствует commit order; cache не оставляет старый allow |
| T11 | connector-contract / 768 | Оба канала dedup/status/generation; late receipt принят; SaleBot calls=0 |
| T12 | inbox-collaboration.e2e / 768 | Два разрешённых сотрудника видят историю, третий нет; repeat click/reconnect не дублируют send; note не уходит |
| T13 | ai-scope-takeover.integration / 769 | Generic tool/child workflow сохраняют scope; takeover до mutation блокирует, после не маскирует commit |
| T14 | automation-admission.integration / 769 | Normal run → COMPLETED; 2 workers/restart → один run, без дублирования эффекта; Redis loss between steps → recovery либо visible stalled по §15.19; import/echo без chain |
| T15 | attachment-security.integration / 770 | SSRF/private redirect/oversize/revoked parent denied; crash finalize восстанавливается, текст сохранён |
| T16 | import-overlap.integration / 770/769 | Все порядки до/после boundary: 1 Message, 0 historical и 1 разрешённый live effect |
| T17 | message-revision.integration / 770 | Delete-before-create/late edit/unknown order не воскрешают текст/AI context |
| T18 | migration-restore.integration / 771 | Fixture upgrade/restore DB+files+journals; старый outbox fenced до reconciliation |
| T19 | policy-contention / 766; capacity-recovery / 771 | Утверждённая нагрузка; backlog/latency/unknown/audit alerts, нет бесконечного retry |
| T20 | free-self-hosted-acceptance / 771 | Без Enterprise key, оба тестовых канала без SaleBot, без реальных клиентов |

T02/T06/T08/T13/T16 имеют отрицательный контроль: отключение writer/guard/fence/suppression обязано уронить тест. Mock не доказывает PostgreSQL concurrency. Команды из CLAUDE/project.json: shared build, single Jest file, прямой package tsgo, integration Jest config на явно изолированной БД, UI component/e2e. Полный with-db-reset target не получает production env.

## 12. Эксплуатация и переход — ROB-771

Пакет: full Git/image SHA, migrator/schema/worker version, config/secret references, сверка running image/mounts. Build CPU/RAM/maxWorkers по измерениям, PSI/OOM monitoring и stop ненужного builder после работы; глобально алармы не подавляются. Один application stack, тестовые ресурсы явно отделены.

Метрики без переписки: receipt lag/retries/quarantine, command pending/unknown age, connector heartbeat/generation, consumer lag, AI failures/cost, policy denies/revokes, audit failures, storage/queue capacity. Correlation event→command→job→provider receipt. SLA/thresholds по выбранной нагрузке, до неё только технические ошибки/configured limits.

Restore rehearsal: согласованный комплект PostgreSQL/storage/connector journals/secrets, checksums и reference времени. Startup fenced без sends; сверка command/native IDs с journal/provider, unresolved unknown видимы; только затем восстановить owner/dispatch. Старая DB не отменяет уже отправленное, outbox нельзя просто replay. До любых клиентских подключений обязателен внешний maintenance/access fence UI/API/SSE/worker, invalidation sessions/API keys и external grant reconciliation по §15.21/G12.

Cutover route: inventory реально используемых функций SaleBot→acceptance→freeze новых старых исходящих→drain/reconcile unknown→capture boundary/checkpoint→generation/owner switch в connector registry→новый credential→replay inbound→доказать одного CRM-dispatch owner/account/generation (§15.24)→наблюдение согласованного окна. Connector authoritative owner; Twenty binding disabled до подтверждённого handshake новой generation. Distributed atomicity между CRM/connector не предполагается. Старые receipts идут reconciliation path, старые sends rejected.

Rollback: freeze Twenty sends→drain/reconcile→сохранить journals/checkpoints→switch generation единственного owner→совместимый package/данные после анализа. Не запускать двух sender и не переотправлять pending из старой копии. Полное отключение SaleBot только после утверждённого inventory функций общения и отдельного разрешения конкретного окна.

Restore не открывает доступ по восстановленным grants: maintenance/access fence, invalidation sessions/API keys и external grant reconciliation обязательны (§15.21/G12).

## 13. Единый реестр решений и gates

Ни одно значение реальных настроек не выбрано за владельца. Эта таблица — единая точка учёта; ссылки в разделах 15 уточняют механизм. Без настройки блокируется указанная активация, а не разработка synthetic tests. Правила безопасности и собственный ACL — принятые технические требования, не предложение принять риск.

| ID | Решение / проверка | Срок и поведение до решения |
|---|---|---|
| G01 | Матрица ролей/команд, stage visibility; отдельный выбор нескольких воронок | До реальных пользователей; synthetic explicit grants, не allow-all |
| G02 | Telegram/MAX accounts и тестовые адресаты | До внешних sends; fake adapters |
| G03 | QR/login внутри Twenty или внешняя панель | До onboarding UI; binding/status contract можно реализовать |
| G04 | AI provider/model/budget, knowledge ACL, условия auto, включение внутренних заметок в AI context | До auto activation; stub/synthetic context ; выбор допустимого раскрытия CRM-данных в общей переписке/выводе ИИ обязателен до auto (§15.23) |
| G05 | externalHumanReplyPolicy | До auto: pause либо выбранное явное правило; отсутствие значения запрещает auto |
| G06 | managerReplyPolicy | До auto: takeover_on_send либо require_explicit_takeover; конкурирующие human+AI replies не default |
| G07 | responders + общий reply/effect budget на root admission для агента и workflows, burst/debounce/time budget и предельное опоздание CRON (cron-gap) | До auto и совместной активации отправляющих consumers; нет выбора → activation denied; fixtures явные |
| G08 | Default active queue того же binding, QueueGrant: кто читает/берёт/отвечает; minimal Person projection | До binding activation; невидимый клиентский inbox не включается |
| G08b | Автосоздание Person из верифицированного live identity и разрешённые поля | По умолчанию disabled; включение явно администратором с правом create и audit; import/restore никогда не создаёт Person автоматически |
| G09 | Custodian membership и процедура переназначения | До binding activation; удаление без successor не оставляет dangling owner |
| G10 | Import source/accounts/range; old-content retention; purge/attachments policy | До реального импорта/очистки; synthetic history, automatic deletion disabled |
| G11 | Нагрузка, inventory SaleBot и сторонних отправителей, externalServiceReplyPolicy | До account activation/capacity acceptance/cutover; SLA не обещается |
| G12 | Backup/restore objective, recovery window и journal retention | До live cutover; runbook/rehearsal, gaps блокируют auto ; обязательны maintenance/access fence, session/API key invalidation и external grant reconciliation (§15.21) |
| G13 | Connector/userbots/DB host, network boundaries, volume, backup owner, account dispatch ownership. G13b — unknown-send liveness: для каждого канала без гарантированного status/cancellation proof владелец явно выбирает: принять возможную бессрочную блокировку auto после unknown human send либо не активировать auto на этом канале. | До integration deploy; contention target до ROB-766 integration expansion; isolated fixtures, работающий SaleBot не меняется. До выбора auto activation запрещена; риск не считается принятым самим планом. |
| G14 | Изоляция внешних тестов: synthetic workspace (проверить флаг/маршрутизацию) либо отдельная binding/queue | До внешних test sends; флаг автоматически не включать |
| G15 | Операционное окно разделения runtime/migration DB ролей | До append-only production guarantee; только тестовые роли в fixtures |
| G16 | Разрешённые external integrations/webhooks на данные чата | До их activation; raw generic omni events запрещены |
| G17 | Служебные workflow-уведомления в human/assist | До exception activation; default disabled; AI-content exception запрещён; governance/root/budget обязательны также для non-message triggers (§15.14, design/09) |
| G18 | Лицензионный/dependency preflight независимой сборки | До production rollout: own baseline/row ACL не зависит от Enterprise helpers, статический и runtime inventory (§15.13); не запрос подписки; проверить Corresponding Source offer по LICENSE AGPL §13 для изменённой версии с сетевыми пользователями |
| G19 | Подпись менеджера клиенту: none / approved отображаемое имя, формат и разрешённые поля | До включения подписи; пока disabled, не раскрывать внутреннее имя/PII автоматически; server renderer после ACL, не произвольная настройка caller |
| G20 | Переоткрытие closed диалога новым входящим: ручное или явная route policy | До auto-reopen activation; default closed сохраняется, сообщение попадает менеджерам; старые отменённые turns не оживают |

Если выбор меняет контракт, ADR обновляется перед patch. Gates не заменяются умолчаниями ревьюера. Telegram/MAX/auto и максимальные прикладные полномочия CRM не урезаются до drafts-only. Внешние группы и Bot API аккаунты остаются необязательными расширениями, а не условием готовности заявленного сценария.

## 14. Последовательность и журнал

ROB-764→765→766→(767+768)→(769+770)→771. «+» не разрешает одновременную правку общего файла. Reviewable порции: контракт/миграция→узкая server operation+test→adapter/UI→integration. Новая функция не готова только из-за зелёной сборки.

DEVLOG: контракт, changed files, команды/фактические результаты, commit и ограничения. Linear: статусы/зависимости/ссылки. План и его review не закрывают implementation issues. Финальный independent pass проверяет весь объект и contract, затем отдельно reconciles предыдущие findings; не только перечень старых замечаний.

## 15. Дополнительные обязательные контракты по исходникам

### 15.1 Таймлайн и защита канонической истории

ROB-766 включает `engine/core-modules/messaging/services/{timeline-messaging,get-messages}.service.ts`, `timeline-messaging.resolver.ts`, `utils/{format-threads,get-effective-message-channel-visibility}.util.ts`. В текущем TimelineMessagingService есть bypass repositories и выдача lastMessageBody; видимость аккаунта не равна собственному доступу к диалогу. Для omni thread все list/search/fallback/legacy person/company/opportunity timeline routes, participants и counters получают conversation ACL до query; владение connectedAccount не bypass. Нельзя просто скрыть body после выдачи subject/count.

ROB-764 защищает lifecycle уже при добавлении omni binding: generic update/delete/merge Message/Thread/Participant/associations для принадлежащих ему строк запрещены вне типизированной доменной команды. ROB-766 добавляет чтение через все эти пути. Раннее запрещение mutations не ждёт готового UI.

Общий repository guard охватывает insert/update/batch/delete/soft-delete/restore
Message, MessageThread, MessageParticipant, channel association, folder junction и
ThreadTarget. Проверяются сохранённые before и назначаемые after parent IDs,
включая оба родителя folder junction. Ownership определяется MessageLink,
Conversation и binding любого статуса с учётом удалённых associations, не prefix
header. Bypass permissions и skip events не обходят guard. Под
[native ownership fence](contracts/access-control.md#lock-protocol) строки блокируются,
перечитываются, а SQL ограничивается исходным условием AND захваченными IDs с
внешней группировкой OR. Ошибка ownership query означает отказ. Parent FK
SET NULL/CASCADE, raw SQL и metadata lifecycle не становятся защищёнными только
из-за проверки дочерних kernels; для них остаётся отдельный T22 inventory.

Ранний hard-delete guard родителя проверяет retained ExternalIdentity.personId и
ConversationTarget по точной тройке workspace/objectMetadataId/recordId, включая
inactive target без projection. Для Person/Company/Opportunity дополнительно
проверяются native participant/target references; для MessageCampaign — ссылки
Message/Participant. Вне доменного lifecycle запрещено каскадно менять owned
историю; native capability сама по себе не разрешает destroy родителя. Штатное
WorkspaceMember SET NULL сохраняется, если нет отдельного retained core target.
Soft-delete/restore CRM-родителя не заменяет hard destroy и не запускает FK cascade.
Будущие writers retained identity/target references обязаны держать exclusive
ownership fence перед изменением связи, поскольку core UUID не имеет FK на parent.

`BlocklistItemDeleteMessagesJob`, `MessagingMessageCleanerService`, jobs/listeners удаления channel/connectedAccount, reset-channel/remove-orphans и delete-folder/group-email services не удаляют omni canonical records. Политика владения читается из core binding/tombstone, а не только существующей строки удаляемого канала. Обычное отключение/удаление аккаунта с omni history отклоняется или преобразуется в domain disable до разрушительного lifecycle; cleanup jobs повторно проверяют persisted marker. Controlled purge — отдельная операция с permission, manifest Message/links/files/revisions, IncomingReceipt.validatedEnvelope, DomainEvent/dispatch payload snapshots, OutgoingCommand payload/reply/files, protected AI/workflow artifacts и connector/userbot captured_events/command bodies, audit и retention; по умолчанию запрещена. Re-enable на том же provider account сохраняет bindingId/history, меняет session/generation; другой реальный account не подменяет старую binding.

Tests T21: менеджер с Person/connectedAccount, но без conversation grant, вызывает timeline/search/fallback/legacy endpoints — нет body/subject/participants/count. T22: blocklist/channel/account removal/reset/orphan cleanup/generic delete — история/links/files сохраняются либо явный отказ; обычный email fixture сохраняет старую cleanup семантику. ROB-764/766 не готовы без этих тестов.

### 15.2 Идентичность источника, контакта и внешнего автора

Различаем `sourceEventKey` (idempotency доставки) и `nativeMessageKey` (одно логическое сообщение). MAX bridge journal имеет UNIQUE(account,chat,messageId,direction,content_empty), что подтверждено source schema: это варианты source events, а не автоматически два разных bubbles. Adapter contract v1 включает raw ID, direction, source variant и canonical key version. Сравнение placeholder→populated сохраняет оба receipts и одну canonical Message, если adapter доказал одну identity; противоположные направления/неоднозначные variants не склеиваются. Mapping tests на реально выбранной версии предшествуют включению adapter. MessageLink UNIQUE использует versioned canonical nativeMessageKey; raw ID сохраняется для диагностики. Если native order/identity не доказаны, quarantined/reconciliation, не silent drop.

Доверенная граница ingress сохраняет `trustedCaptureContext` и его canonical
hash в одной транзакции с receipt/audit, отдельно от внешнего envelope. Контекст
v1 связывается через `envelopeHash` с полным нормализованным envelope и содержит
server-selected origin (`live/history_import/restore_replay`), ссылку
qualification adapterId/version, уже квалифицированный nativeMessageKey/version,
подтверждённые sourceVariant/sourcePosition. Это происхождение захвата, не actor.
Закрытая schema и hash не доказывают доверие: отдельный обязательный server
authorizer проверяет origin и зарегистрированную qualification для binding под
policy/binding locks до новой записи и каждого replay. Wire payload этих полей
не принимает. Выбранный callback и detached/frozen context фиксируются до await.
Повтор eventId сравнивает wire hash и capture hash; изменение либо NULL→qualified
не перезаписывает receipt. Прежний/внутренний неквалифицированный приём сохраняет
оба поля NULL: такой receipt нельзя применять как live/квалифицированный без
отдельного доказанного reconciliation. Ни schema, ни поздний worker не выводят
canonical identity/order из raw ID и не назначают происхождение по умолчанию.
Обычный ingress сохраняет current generation fence; old-generation restore
потребует отдельного authenticated recovery path по §15.4.

SaleBot.history возвращает identity_verified=false/direction_verified=false/replay_ready=false в исследованном коде. Поэтому SaleBot record ID не считается native Telegram/MAX ID. Source adapter либо предоставляет проверенную mapping, либо сохраняет history в namespaced legacy key и отключает автоматическую cross-source dedup; UI показывает legacy/unverified provenance, отчёт содержит возможные дубли. Даже неперекрывающиеся даты не доказывают идентичность; точное объединение только после mapping. Auto effects из legacy import запрещены. Чистая native/connector history имеет свой проверенный native key и полноценные overlap tests.

Person/Company merge/soft-delete/restore через CommonMergeMany и direct writers получает lifecycle adapter в том же executor. Он переводит ExternalIdentity и все omni-owned ссылки на survivor (MessageParticipant.personId, message/thread target associations и обнаруженные metadata MANY_TO_ONE связи) через withOmniRepositoryOptions с audit, policy epoch и AI-context invalidation. CommonMergeMany partition-ит строки по persisted omni ownership ДО generic related-record migration: omni rows исключены из обычного update/soft-delete и передаются adapter; email/non-omni rows сохраняют существующий путь и события. Domain-only guard разрешает только trusted lifecycle adapter, caller flag не bypass. Общий transaction/lock order покрывает обе ветки и source+survivor; текущие права проверяются до миграции и удаления проигравшей записи. Snapshot автора/тела/history и conversation grants не меняются из-за merge. Конфликт уникальных связей разрешается без удаления сообщений и изменения исторического автора; если безопасный mapping не доказан, вся merge transaction откатывается с видимой ошибкой. Cross-workspace merge denied. Person deletion не удаляет историю; новая случайная Person не подставляется. T23: mixed email+omni participants/targets → merge успешна, 0 generic omni events, прежние email events, identities на survivor, rollback обеих веток, collision и denied survivor не оставляют partial update.

Внешнее исходящее без Command (телефон/другой разрешённый transport source) сохраняется как canonical outgoing с actor external_sender/unknown provenance. Оно не запускает incoming automation и не связывается с AI command по тексту/времени. Auto mode требует выбранной externalHumanReplyPolicy: pause+epoch либо keep с явным принятым правилом; до выбора auto activation denied. Это product gate, а не молчаливое решение за пользователя. T24: external echo/no command, echo-before-ACK, concurrent AI send, обе выбранные политики.

### 15.3 Autonomous principal, устойчивые эффекты и отмена

Определение: [access-control — scope](contracts/access-control.md#scope).

Knowledge v1: реестр источников с resource identity/version и explicit ACL, адаптер чтения разрешённых Twenty notes/documents/files; общие материалы явно отмечаются administrator policy. Skills/prompts не автоматически являются клиентской knowledge base. Retrieval result хранит provenance и policy epoch; revoked/deleted resource не попадает в новый prompt. Векторный index не вводится до необходимости; если добавляется, metadata ACL и stale-index deletion отдельные tests.

Определение: [workflow-execution — design-31](contracts/workflow-execution.md#design-31).

Определение: [workflow-execution — turn-lifecycle](contracts/workflow-execution.md#turn-lifecycle).

После crash в dispatching recovery повторно проверяет текущие actor/policy/epoch перед любым новым enqueue. Status not-found не разрешает старому AI send пережить takeover. Connector `cancelCommand` атомарно с claim journal возвращает cancelled либо too_late; отмена очереди возможна до provider-call boundary, после — reconciliation, без ложного cancelled. Pending send cancellation сохраняется durable outbox; при unavailable connector виден cancelRequested=true/unknown, не обещание мгновенной отмены. Право caller на отмену определяется единым правилом [command-states](contracts/sending-ui.md#command-states); transport caller не может отменять команды другого workspace/исторического владельца. Если старый HTTP enqueue может ещё прийти после cancel, connector хранит cancel tombstone по commandId, чтобы поздний enqueue не воскресил его. Перед provider call journal сверяет актуальную tombstone/generation.

Определение: [workflow-execution — design-49](contracts/workflow-execution.md#design-49).

T25: broad app-role auto X не читает Y; assist/tool/child не расширяют scope. T26: kill после effect commit до turn result, regenerated tool ID/payload — один эффект/Command. T27: burst/new message while generating + crash — bounded turns, никаких потерянных pending admissions. T28: dispatching crash→takeover→status not found; cancel vs late enqueue; no stale provider send до оговорённой external boundary.

### 15.4 Restore и договор хранения журналов

Binding хранит acknowledged source journal cursor/high-watermark и adapter journal epoch. Connector сохраняет ACKed events и terminal command/effect evidence как минимум на согласованное recovery window (backup age + обнаружение + восстановление + запас). Это gate реальных данных; default 30 дней не доказательство достаточности. Готовность проверяет earliest replay cursor/status retention. HTTP 410/gap блокирует auto/cutover, создаёт отчёт неполноты; не объявляет replay успешным.

После restore весь binding fenced: inbound restore replay разрешён, business admission/AI/workflow/send отключены. Сверить restored receipt watermark с connector journal, повторить ACKed lost range и canonical messages; сверить outgoing/effect ledger, native confirmations, generations/owner. Для восстановленного диапазона origin=restore_replay подавляет автоматические эффекты до отдельного reconciliation; потерянный admission не означает право повторить ответ. Неизвестные command receipts сохраняются orphan-receipt quarantine. Создать исходящий Message допустимо только при доказанном native account/chat/message, actor external/recovered unknown; нельзя выдумать менеджера или отправку по receipt без подтверждения.

Recovery auth отделяет текущую авторизацию journal replay от original event generation/hash. Старый immutable envelope сохраняется, transport request подписан текущим узким recovery credential. Обычный revoked sender не может использовать этот путь. Owner/route поколение берётся из connector registry, не откатывается blindly со старой DB. Снятие fence только после отчёта gaps/unknown/effects и выбранной activation boundary; replay не переигрывает уже совершённые provider effects.

T29 restore snapshot до receipt ACK/AI admission/Command, connector помнит отправку: восстановленная история полна в доступном диапазоне, повторных автоответов нет, старые/unknown receipts видимы, journal gap блокирует automation. Это расширяет T18, не ограничивается outgoing-only reconciliation.

### 15.5 Метаданные, права БД, ревизии и тестовая среда

Opportunity.stage сейчас string SELECT, не FK Stage. Wire contract — `targetStageValue` + `expectedStageOptionsHash`, StageRule использует optionValue для read/edit, fromValue/toValue для transition и explicit wildcard для неприменимых полей; полный UNIQUE включает action/principal и все три значения по §3; хэш канонического набора значений конкретного SELECT проверяется отдельно. Глобальный workspace.metadataVersion не входит в identity rules: постороннее изменение метаданных не инвалидирует разрешённые переходы. Label переименование не меняет optionValue; изменение/удаление optionValue отклоняется при активных rules до одной audited migration rules+metadata. Поддержка нескольких воронок — отдельный product gate; существующей сущностью не объявляется. T30: metadata rename/delete/stale client/generic update в одной policy модели.

Native Twenty role/member assignment revoke должен брать тот же policy fence/epoch, что own grants, включая metadata QueryRunner path. Иначе broad native role остаётся stale в AI context. T31: native role revoke vs AI mutation/export/SSE даёт правильный commit order. Membership removal инвалидирует все связанные references.

Audit catalog versioned: business objects Person/Company/Opportunity/Task/Note, omni commands/entities, security/role/session и workflow/AI actions; технические indexes/cache/heartbeat не получают рекурсивный row audit. Email mutations сохраняют author/source и минимальный safe diff по catalog; объём измеряется T19. Runtime DB роль отделяется от migration owner до включения SQL append-only. App startup не исполняет upgrade с runtime role: отдельный migrator job, затем server/worker с ограниченным PG_DATABASE_URL; развёртывание не добавляет migrator secret в app env. Core/workspace используют одну runtime role/БД для общей транзакции. Существующий админский runtime role нельзя считать защищённым REVOKE. Проверить все upstream migration/auth/job paths с этой ролью, не ослаблять audit grants при первом permission error.

Ревизии: `OmniMessageRevision` (workspace,messageLinkId,providerRevision/sourceEventId,contentHash,redacted metadata,optional encrypted body,file references,tombstone,origin) + unique source revision. Сохраняется атомарно с canonical edit/delete; разрешённое чтение через current conversation ACL. По умолчанию до retention решения хранится факт/hash без старого полного body; если требуется просмотр полного старого текста, это explicit policy до запуска и отдельный protected payload retention. Историю ревизий не обещать восстановимой из audit. T32: исходный факт edit/delete не теряется, payload retention/denial/revoke соблюдены.

Upgrade release manifest перечисляет команды по имени/SHA/timestamp и применённый cursor. После первой fork-команды upstream не обновляется обычным merge+start: проверить late timestamp commands перед cursor и явно подготовить новую idempotent reconciliation command в разрешённой текущей версии либо отдельный проверенный переход. Старые cursor/committed migration не переписывать. T33: новая команда в той же 2.52 выполняется, ранее выполненная не повторяется; late upstream before cursor обнаруживается preflight и блокирует rollout.

Дополнительный факт по коду: UpgradeSequenceReaderService.getUpgradeSequence группирует fast-instance→slow-instance→workspace, а не сортирует весь релиз по timestamp. ResolveStartCursor после применённой workspace команды не возвращается к новым instance командам той же 2.52. Поэтому одного нового timestamp для нашего уже обновлённого экземпляра недостаточно. Выбранный план fork migrations: SQL/up/down первоначально генерировать штатным generator в текущую version directory, затем переносить в `database/commands/fork-upgrade/steps/`, удалять добавленный generator import/provider из `instance-commands.constant.ts` и `@RegisteredInstanceCommand`, заменяя fork-only marker. Не изменять старые upstream команды. Использовать fork-only command manifest/registry и отдельный `ForkMigrationRunner` с ledger `(migrationId,checksum,status)` в core и advisory lock БД. Fork-only providers не регистрируются в upstream upgrade discovery; marker/decorator и module boundary тестируются. Bootstrap ledger выполняется migrator role идемпотентно, DDL+ledger-success одной транзакцией; нет reset/редактирования upstream cursor. Runner использует up/down(QueryRunner) сгенерированного command, не дублирует SQL вручную. Startup sequence: отдельный fail-fast migrator upstream upgrade→fork migrator→schema/checksum verification→runtime. На server/worker DISABLE_DB_MIGRATIONS=true; штатный entrypoint, продолжающий запуск после failed upgrade, не является миграционным gate. Runtime readiness сверяет ledger/checksum и отказывает до готовности схемы. Integration setup/reset также вызывает fork runner. Fresh install проходит обе последовательности, existing 2.52 также выполняет новые fork steps. Checksum drift/unknown partial schema — отказ и диагностика, не слепое adoption. Это обоснованное расширение миграционного orchestration, а не произвольное отступление от генератора. T33 дополнить fresh install vs upgraded 2.52, crash DDL/ledger, concurrency двух migrators, отсутствие fork commands в upstream sequence. До этих tests rollout entity изменений блокируется.

Автотесты: локальный Windows→WSL/Linux runtime с ephemeral PostgreSQL/Redis и уникальным test database name; адрес/имя running demo запрещены preflight. Серверная сборка не равна месту DB tests. Внешние test sends этапа 4 — выбранные тестовые аккаунты и согласованная изоляция существующего экземпляра. Отдельный synthetic workspace возможен только после проверки IS_MULTIWORKSPACE_ENABLED и маршрутизации; автоматически включать флаг нельзя. Альтернатива — выделенная binding/queue с explicit grants в существующем workspace, без реальных адресатов. Выбор до внешнего теста остаётся gate; automated DB tests независимы от этого выбора. Cleanup только по testRunId, через доменные операции с аудитом, не общей очисткой канала. Если test env отсутствует, реализация тестов готовится, прохождение не заявляется.

Каждая import batch перечитывает текущее право инициатора/import service policy; revoke останавливает новые страницы и оставляет cursor. Текущая транзакция сериализуется с policy fence. Gates добавлены: externalHumanReplyPolicy, burst/debounce/max effects, old-content retention, recovery window/backup policy, optional multi-pipeline. Они блокируют только соответствующую production activation, а тесты параметризуют варианты.


### 15.6 Полная маршрутизация событий и производные права

Omni Message/Thread/Participant/Association и их target updates пишутся через `transactionScope.getRepository(...,{shouldSkipEventEmission:true})` как при live, так и при import/replay. Иначе `EntityEventsToDbListener` отправит payload в webhook/logic function/agent trigger, SSE и timeline; `PendingWakeUpDatabaseEventListener` отдельно разбудит AgentRun. Нельзя подавлять только workflow или добавлять несуществующее поле origin в WorkspaceEventBatch. Для смешанной транзакции suppress применяется к omni репозиториям, не отключает события остальных разрешённых CRM mutations. Прямое ручное emit для omni также запрещено; registry writers покрывает raw paths.

Реестр потребителей ROB-764/769: objectRecordEventPublisher/SSE → sanitized durable projection с current ACL; webhook/logic function → никаких raw omni events, explicit typed integration может добавляться только через DomainEvent consumer+scope+audit; CallAgentDatabaseEventTriggersJob и штатный database-workflow listener → не вызываются для omni, выбранная автоматизация только через admission/turn; PendingWakeUpDatabaseEventListener → без raw omni wake-up; timeline activity → safe summary без тела/скрытого diff; event-log sink → не источник обязательного аудита, отдельный CrmAuditEntry. DomainEvent не переиздаётся в общий wildcard emitter. Включение пользовательских внешних вебхуков для переписки требует отдельной политики доступа и destination; не включается автоматически. T14/T16: live/import при настроенных всех перечисленных listeners дают ноль обходных вызовов; разрешённая typed automation один раз; отрицательный контроль снятия suppression.

ROB-766 включает TimelineActivity, Note/NoteTarget, Task/TaskTarget, Attachment и junction/derived records, а не только корневые CRM records. Доступ к target association требует доступа к её родителю и отображаемой цели. Для общего Note/Task с несколькими parents: body/diff доступны только когда разрешены все раскрываемые protected parents, либо явное отдельное безопасное sharing решение; нельзя открыть целый note по одному доступному target. TimelineActivity видна лишь при доступе ко всем раскрываемым ресурсам/полям; для скрытой цели не выдавать label/count/diff. Files наследуют parent ACL. Note/Task без protected parent требуют собственного grant. Parent/target mutation пересчитывает scope и epoch атомарно.

До первого patch ROB-766 создать полный актуальный inventory `shouldBypassPermissionChecks`, raw QueryRunner/SQL и direct caches: file/symbol, caller/auth principal, tenant, раскрываемые данные, intended rule, test. Автоматический scan — список кандидатов, не доказательство разрешённости. `timeline-activity.repository`, `timeline-activity-target-query`, note/task post-query hooks и related-person-ids входят обязательно. Неинвентаризированный интерактивный обход blocks этап. Instance-admin workspace export и impersonation: отдельное явное system-admin разрешение, MFA/session policy по имеющейся auth инфраструктуре, audit start/finish/actor+impersonatedActor, export artifact ACL/expiry; обычный manager/API key не получает этот путь. Привилегированный incident/export bypass явно фиксируется, не наследуется agent/app role. T07/T08 проверяют оба случая и principal API-key (scoped grants, revoke), а также все derived relations.

QueueGrant `(workspace,binding/queue,principal,actions[read_unassigned,claim,reply])` задаёт видимость новых неназначенных диалогов. Bootstrap administrator обязан выбрать queue policy перед activation binding; иначе activation denied, а не невидимый входящий клиент. Claim сериализуется, grants проверяются заново; после назначения действует explicit conversation/team policy. Видимость conversation не открывает Person автоматически; minimal contact fields выдаются только отдельным ограниченным projection grant. T12: новый unbound чат видят два разрешённых оператора, не третий; claim race, attachment/search counts, связь со скрытой Person не раскрывает её.

### 15.7 Коннектор: схема, состояние, эхо и поколения

ROB-768 выделяет destination Twenty из C/bridge, не переносит работающую БД и SaleBot runtime. Схемы C/schema.sql и C/store.py реально имеют routes/events/jobs/attempts/cursors/resolutions. Переиспользуются route identity и доказанная механика claim/lease/attempts/dedup; таблицы jobs mirror/variables, sb_client_id, legacy_webhooks и SaleBot notifications исключаются из целевой зависимости. Выбранный код переносится с SHA/license, regression fixtures. Telegram app/store.py commands/random_id/recovery и MAX bridge_journal остаются владельцами provider-level evidence, не заменяются догадками центрального коннектора.

Целевая новая namespace/schema коннектора (отдельный service DB, не Twenty core):

| Таблица | Identity и данные | Переход/проверка |
|---|---|---|
| account_owners | UNIQUE(platform,accountId), ownerInstanceId, generation, state, credentialRef | enabled→fenced→draining→enabled нового поколения; switch только после handshake, CAS generation |
| route_map | stable routeId, account owner, providerChatId, destinationBindingId | UNIQUE(account,chat); без SaleBot client ID |
| captured_events | sourceEventKey UNIQUE(account,sourceKey), nativeMessageKey, captureGeneration, originalPayload/hash, sourcePosition, originCommandId nullable, correlationState | immutable envelope; supplemental correlation record не меняет hash receipt |
| delivery_receipts | UNIQUE(eventId,destinationInstance), crmReceiptId, ackState, retries,nextAttempt | pending→ACKed только после durable CRM ACK; ACKed retained по recovery window |
| send_commands | UNIQUE(commandId), immutable ownerInstance, payloadHash,target,generation,state,leaseToken,effectStarted,nativeId,result | queued→claimed→provider_started→confirmed/failed/unknown; timeout не failed |
| command_cancel | UNIQUE(commandId), immutable ownerInstance, requestedAt,generation | cancel-before-enqueue сохраняется; проверка под тем же lock с claim/provider boundary |
| command_attempts / resolutions | commandId,token,version,outcome,evidenceRef | terminal evidence append; проверяемое resolution по [контракту](contracts/sending-ui.md#outcome-resolution) |
| checkpoints | account/source, journalEpoch,cursor,earliestRetained | durable receipt before advance; gap explicit |

Registry commandId глобален внутри connector и сохраняется между владельцами/поколениями вместе с cancel tombstones. ownerInstance — immutable authorization attribute, не часть dedup key. Повтор другого owner не создаёт запись и не раскрывает старый результат: denied/owner conflict, доступ к historical evidence только узкому reconciliation service после проверки binding/route и прежнего owner. Смена generation не переписывает исходную Command; новая отправка — новое намерение/ID. T11/T29 проверяют reuse ID при смене owner, lost ACK, cancel-before-enqueue и отсутствие resend после restore.

Central connector ACK означает durable command в его БД. Перед вызовом userbot он сверяет owner/generation/cancel, но это ещё не provider boundary. Та же idempotent command и cancel fence обязаны дойти в journal userbot: поздний сетевой enqueue после отмены не возрождает send. Только userbot, непосредственно вызывающий provider, вправе вернуть cancelled/too_late относительно provider-call. Неизвестность central↔userbot тоже unknown, reconciliation по тому же commandId. Смена owner fencing также проверяется userbot; центральный CAS без этого недостаточен. T11/T28 fault injection на обеих границах, per-chat order и process crash; SQL/SQLite транзакции реальны, не только mocks.

Echo: outgoing event сначала `correlation_pending`; отсутствие Command в Twenty не доказывает внешнего автора. Userbot journal связывает originCommandId по подтверждённому native send result/устойчивому provider ID, а коннектор публикует correlation update. При ещё незавершённой отправке в этот чат echo удерживается в durable journal либо доставляется pending без изменения mode/epoch. Только доказанное externalOrigin применяет externalHumanReplyPolicy. Если корреляция неразрешима, reconciliation с явной неопределённостью; не автоматический external_sender. T24: собственное AI echo-before-ACK не ставит auto на pause; доказанный external reply следует выбранной политике; crash не теряет удержанное echo. Author audit/MessageLink хранит actor immutable snapshot/member ID независимо от participant.workspaceMemberId: штатный email rematch обязан исключать omni participants; immutable snapshot не заменяет этот запрет (см. §15.18).

Capture generation неизменно записывается при захвате события. При cutover неподтверждённый старый event не переподписывается новым semantic generation. Обычный ingress принимает только current generation. Узкий reconciliation endpoint проверяет актуальные recovery credentials, original hash и evidence исторического owner из connector registry; canonical receipt key не меняется. Это тот же контракт replay, что §15.4, применяется и к cutover, и к restore. T11/T18: pending old generation, repeated old/new transport signatures, ни потери события, ни hash conflict от переписывания generation.

Размещение connector/userbots/DB, владелец backup и network boundaries — gate до интеграционного deploy. План выбирает отдельный transport process и отдельное хранилище; физический host/managed DB/volumes не выдумываются. До выбора используются isolated integration fixtures. Работающий SaleBot connector не изменяется переносом исходников.

### 15.8 Lifecycle, DB privilege и запуск

Omni ConnectedAccount имеет `provider=app` (ConnectedAccountProvider.APP), `applicationId=NULL`, `connectionProviderId=NULL`; binding владеет отдельным APP channel. Provider/application/provider IDs существующего account неизменны через generic metadata: переход требует отдельного lifecycle, сейчас он запрещён. Reconnect и фоновые provider writes сравнивают identity/custodian в UPDATE и исключают любую retained binding, в том числе legacy binding на другом provider; новый bootstrap такие записи не создаёт. New-account INSERT не перезаписывает совпавший id. Реализация и compatibility tests — [LOG053](../implementation/log053/README.md). AccountBinding содержит FK на connectedAccount и messageChannel с `ON DELETE RESTRICT` (workspace consistency дополнительно проверяется); каскады Application/Provider/UserWorkspace/account не стирают канал молча. Lifecycle guard переводит disconnect в domain disable; до реализации domain adapter generic lifecycle для owned account запрещён. Финальная ordinary DB мутация выполняется под shared native fence и свежими account locks/ownership; delete дополнительно блокирует фактические child channel rows до каскада и формирует events по ним. Network hooks остаются вне DB transaction. Webhook local status writes используют ту же fresh ownership boundary для message/calendar; callback сверяет captured connectedAccountId после locks. Ошибки локального commit не передаются в provider exception recovery. Sync-status batches блокируют все accounts до всех channels; authFailure сразу берёт write locks. Folder reset и authFailed выполняются тем же manager; postcommit эффекты используют только фактически изменённые IDs и captured recipients. Channel settings и derived pending group action записываются атомарно после повторной проверки current parent/type/busy state и полномочий caller по locked account. Cursor callbacks сверяют captured parent и fresh ownership; folder cursor/channel reset используют одну транзакцию. Group cleanup pins parent/action/settings/exact DB updatedAt for each strict native chunk and atomic finalizer; stale stops subsequent chunks and list-fetch. Already committed chunks remain committed. Folder action pages also pin current folder/channel versions and use the same native transaction for cleaner and junction deletion. Deletion finalizer holds exclusive ownership fence and requires no remaining junctions. Import finalizer validates captured full hierarchy; strict Gmail selection refuses incomplete labels. Unknown commit propagates. Folder discovery captures current identity/policy/folder set before network and rechecks the snapshot under the same ownership locks before atomic reconciliation/readback. IMAP endpoint changes reject stale responses; stored pending actions survive discovery. Provider final writes reuse full derived ownership under shared fence/account write lock; strict outer owners preserve unknown commit, same-manager readback and shared app authorization. Postcommit callbacks require their own current-parent boundary. Reconnect reset/schedule now returns accepted IDs under captured-parent/current-enabled checks; queued list jobs pin expected parent. Message import cache now uses account-scoped keys at all five owners, with legacy reset/refetch preserving pending actions and legacy-only delayed cleanup. Guarded scheduling returns accepted account descriptors for the migrated cron/CLI paths; import jobs revalidate current ownership and stale recovery rechecks timestamps under lock. Message list cron/CLI/webhook retain accepted account provenance; member blocklist reset checks current custodian under the existing lock. Notification dispatch retains captured parent before initial schedule and isolates account dedup; calendar inline scheduling requires same-parent IMPORT_PENDING. Calendar cache now uses captured account keys at all four owners, with guarded retained-legacy refetch and parent-pinned failure resets. Microsoft lifecycle now pins account/subscription/clientState/status/expiry through claim, renew and recreation; OAuth unknown commit remains visible. This is local CAS, not external provider fencing. Direct importers now atomically claim scheduled work and carry a PostgreSQL-microsecond run proof through SQL status callbacks and legacy reset. Message list-fetch and recent onboarding now claim current ownership/stage atomically; recent handoff stays LIST_FETCH_ONGOING so completion/recovery requires full history before syncedAt. Message cursor/scheduling callbacks retain the exact run proof. Calendar list-fetch also claims a current run; its cursor and next status finalize in one guarded transaction, and declined fetch prevents webhook inline import. Native SQL result apply now rechecks the exact run under its existing strict native transaction; calendar reads/build/write share that owner. Provider native cleanup also checks run in its strict native owner; parent then child locks and scoped reread protect reference concurrency. Ordinary same-account Redis and contact-job delivery remain legacy behavior, not the omni durable outbox. LOG076 verifies delayed importer native apply and participant/target reconciliation cannot mutate protected omni rows/events after ownership enrollment; ordinary mixed-batch control remains functional. Admission/status are doubles in the importer test, and the full postcommit contact-job pipeline is not claimed. Generic folder CRUD/sync locks accounts, channels and folders in stable order; rechecks captured parent and current custodian; mixed protected batches reject atomically. Temporary failure вычисляет порог по locked current count и атомарно пишет count/retryAfter/stage. Relaunch использует fresh failed-status CAS; scheduling возвращает только committed accepted IDs для очереди. DB constraints — последний барьер для raw cascade. T22: delete app/provider/account/member/workspace, bulk/direct paths; сохранение истории либо понятный отказ, email regression отдельно.

Удаление workspace с omni/audit данными по умолчанию denied с указанием controlled purge. Explicit authorized purge: fence route/userbots, reconcile sends, запрет новых writes, manifest core/workspace/files/journal references, policy retention и аудит операции в отдельном admin ledger без каскада вместе с workspace. Только после проверки manifest возможно удаление; irreversible purge имеет отдельное разрешение и не входит в обычный disconnect. Нет автоматической чистки orphan audit по удалённому workspace.

CrmAuditEntry и admin deletion ledger лежат в отдельной схеме `crm_audit` той же PostgreSQL; explicit schema metadata в entity. Owner — отдельная migrator/audit role, runtime не владеет этой схемой/таблицами/БД, не superuser/CREATEROLE, не наследует owner и не может SET ROLE owner. USAGE+SELECT/INSERT без CREATE/UPDATE/DELETE/TRUNCATE; protected sequence grants только необходимые. Runtime ownership core или создаваемых workspace schemas не даёт права DROP crm_audit. Preflight проверяет effective membership/database/schema/table ownership и отрицательные DROP/ALTER/TRUNCATE тесты. Runtime PG role separation и передача текущего владения — отдельная операция до включения append-only гарантии, не действие документа. Upstream provision/migrations проверяются с этим разделением, permissions не ослабляются молча.

Fork migration split по §15.5 дополнительно: static test запрещает fork decorators/imports/providers в upstream discovery, startup command/module imports runner только явно, autogenerated SQL snapshot сохраняется один раз вне version dirs. Turn/EffectLedger вводятся миграцией ROB-769, metadata-only Revision — ROB-764 (расширение payload в ROB-770), audit schema/writer — ROB-764, queue grants — ROB-766. Integration fixture init/reset использует тот же manifest. T33 проверяет actual command list и fail-fast любой upstream/fork error, не только happy-path DDL.

### 15.9 Порядок блокировок, инструментов и поиск

Определение: [access-control — lock-protocol](contracts/access-control.md#lock-protocol).

Определение: [workflow-execution — design-11](contracts/workflow-execution.md#design-11).

Серверный поиск v1 использует ограниченный запрос Message body/subject + conversation/MessageLink join с ACL до результатов/count и bounded cursor; у Message не предполагается готовый searchVector. При текущей неизвестной нагрузке обещаний latency нет; T19 определит необходимость собственного tenant/conversation scoped text index. Edit/delete немедленно меняет canonical query result; при будущем index вводятся atomic update/delete и stale-index tests. T12/T17 проверяют поиск, запрет раскрытия скрытых targets и удалённых текстов.


### 15.10 Исполнимые точки интеграции workflows и messaging helpers

Определение: [workflow-execution — trigger-registration](contracts/workflow-execution.md#trigger-registration).

Определения: [dispatch](contracts/workflow-execution.md#design-18), [интеграция runner](contracts/workflow-execution.md#runner-integration).

Определение: [workflow-execution — event-projection](contracts/workflow-execution.md#event-projection).

Определение: [workflow-execution — repository-adapter](contracts/workflow-execution.md#repository-adapter).

Канонические ключи в helper adapter: headerMessageId = `omni:v1:` + SHA-256(canonical length-delimited encoding(bindingId,providerChatId,nativeMessageKeyVersion,nativeMessageKey)); messageExternalId = versioned nativeMessageKey; messageThreadExternalId = providerChatId в контексте выделенного binding channel. Raw native IDs сохраняются отдельно. Prefix зарезервирован, обычный APP ingest не может использовать его как headerMessageId; email/provider paths не допускают слияния с omni headers без совпадения ownership link. Перед вызовом helper binding+conversation locks и UNIQUE MessageLink защищают duplicate create; при уже известном MessageLink использовать exact messageId, повторный global header lookup не является oracle идентичности. Обнаруженное старое чужое header совпадение → явный conflict/reconciliation, не reuse чужой записи.

LOG077: currentRevisionId указывает на конкретную редакцию данного MessageLink и workspace через составной FK. Initial creation выполняет Link(NULL) → Revision → head UPDATE в одной транзакции и записывает один финальный Link create audit. Старые NULL не заполняются по времени: replay проверяет единственную initial revision без мутаций. Будущий revision writer проверяет legacy evidence и может сразу установить новый head внутри своей операции; providerRevision не используется как указатель head. Down восьмой миграции отказывается удалять непустые heads.

Helper только создаёт первоначальную canonical Message. Placeholder→filled для одного native key, edit и delete идут через domain revision operation: сравнить trusted source variant/order, обновить точный messageId/body/attachments и current search data в общей транзакции, receipt/revision/audit; не полагаться на no-op существующего helper. Изменение placeholder не создаёт повторный admission/effect; automation получает eligible complete content только один раз по явно определённой adapter completeness, pending placeholder не запускает AI. OmniMessageRevision минимальная metadata-only схема и write service вводятся уже в ROB-764 (перенос из прежнего ROB-770); ROB-770 расширяет защищённый payload/files/retention. LOG078 вводит nullable typed IncomingReceipt.applicationResult; LOG079 реализует qualified metadata-only writer: schemaVersion/kind, disposition=created|advanced|duplicate|stale, selectedRevisionId, observedHeadRevisionId nullable, candidateSourceRevisionKey/contentHash. resultId остаётся MessageLink. Outcome фиксируется вместе с applied/lease-CAS и audit; duplicate/stale не создают лишний native Message, Revision или DomainEvent. Replay возвращает сохранённое решение после текущей авторизации и проверки evidence, не сравнивает событие заново с изменившимся head. SQL gate проверяет applied/non-null resultId/object/version/kind/disposition с IS TRUE; runtime parser строго проверяет поля и UUID-согласованность. JSON revision IDs не являются FK: writer/replay проверяют same-Link/workspace и evidence. Старые NULL не backfill; down отказывается удалять сохранённые outcomes. LOG079 реализует применение и stable replay с same-Link/workspace evidence, native/current-head readback, suppressed v0 events и rollback-safe quarantine. Author/display сохраняются первоначальными, Link.sourcePosition отражает текущий head. Позиции сравнивает обязательный trusted adapter закреплённой qualification версии; numeric comparator в synthetic tests не является квалификацией Telegram/MAX. Body index отдельно не создаётся: штатный Message search индексирует subject, который этот writer не меняет. Files/retention остаются ROB-770.

T01: одинаковые raw IDs в двух аккаунтах/чатах, попытка reserved header чужим каналом, concurrent replay; T17: placeholder→filled/late create/delete-before-fill дают один Message, верный текст/тombstone, два receipts и не более одного допустимого admission.

Native Thread ID задаётся domain writer до создания Conversation и передаётся
штатному helper через optional canonicalThreadIdByThreadExternalId. В этом
режиме нужен active strict scope того же workspace; map покрывает batch точно
и не объединяет разные providerChatId в один Thread. Существующий Thread,
header hit и channel associations должны совпадать с ожидаемым ID. Удалённые
текущие совпавшие Message/association или canonical Thread дают conflict;
несвязанные удалённые исторические строки не препятствуют новому сообщению.
Противоречивые активные ссылки дают conflict, а не новую цепочку. Пустой существующий Thread
переиспользуется по точному ID, отсутствующий создаётся с заранее выбранным ID.
Это persistence contract, не авторизация: owning binding/Conversation/MessageLink,
порядок locks и foreign-header checks остаются обязанностью domain writer.
Email/обычные APP callers без options сохраняют прежнее поведение.

### 15.11 Отправка менеджера, владелец канала и исторический автор

Определение: [access-control — takeover](contracts/access-control.md#takeover).

Omni ConnectedAccount: scope='WORKSPACE', userWorkspaceId — действующий явно назначенный custodian workspace membership; это технический владелец upstream reference, не grant на все разговоры. При binding creation проверяются custodian и queue policy. AccountBinding.status authoritative для omni. Смена scope/archive/isSyncEnabled/userWorkspaceId через generic metadata UI/API либо guarded domain operation, либо denied; email accounts сохраняют upstream behavior.

Перед удалением custodian lifecycle service находит все omni accounts. В общей owner-transfer транзакции под policy/binding locks назначает разрешённого нового custodian без archivedAt/token-null/isSyncEnabled side effects, пишет audit и обновляет ссылки; затем разрешает удаление старого membership. Если нового custodian нет, удаление последнего владельца отклоняется с явным требованием переназначения/controlled workspace purge; висячий userWorkspaceId запрещён. `ConnectedAccountOwnershipTransferService` и metadata.transferOwnership исключают omni из штатного archive path, используя domain transfer; повторный guard проверяет итог при direct/bulk writes. Удаление обычного менеджера меняет grants/epoch, не выключает общий канал. T22/T31: удаление custodian с/без successor, rollback/race, generic archive и native role revoke; history/binding сохраняются, обычный email transfer regression проходит.

Импорт хранит sourceAuthorId/sourceDisplayName/sourceSystem и authorVerification в provenance сообщения/ревизии. Это исторический автор из источника, не автоматически действующий сотрудник CRM. Только explicit audited admin mapping в HistoricalAuthorMapping (revision CAS; sourceSystem/authorId scoped by binding) связывает его с workspaceMember; без mapping UI показывает исходную подпись и unknown/external provenance. Такой автор не получает grants и не становится initiating principal новых effects. Удаление WorkspaceMember делает mapping target unavailable (nullable target + revision bump); source identity и исходная подпись сохраняются. Restore не восстанавливает mapping автоматически. API expectedRevision относится к HistoricalAuthorMapping, создание ожидает0; writer/receipt общий, body сообщения и immutableAuthorSnapshot не переписываются. T16: unmapped/mapped/deleted manager, repeated import и conflicting mapping; ложной атрибуции нет.


### 15.12 Производные данные ИИ/workflow — обязательный own ACL

ROB-766/769 добавляют в protected catalog `workflowRun` (state/triggerPayload/results/errors), `agentChatThread`, `agentChatThreadParticipant/Target`, `agentMessage`, `agentMessagePart`, `agentMessageReaction`, `agentTurn`, AgentRun recordings/stream buffers и файлы/экспорты их результатов. PRIVATE/INHERITED исходного Twenty и право видеть workflow/агента не дают права видеть клиентский контент.

Выбран вариант own derived ACL, без второй копии текстов в новом хранилище. Core `AutomationArtifactScope` связывает `(workspace,artifactKind,artifactId)` с conversation и immutable captured ResourceScope/trustedExecutionReference; его схема вводится ROB-766 до enable omni automation. История/результат не становятся доступны без binding: missing scope для omni-origin → deny/quarantine. Binding создаётся до или в той же транзакции, что публикуемый artifact. Child runs/thread parts/files наследуют корень; tool reads разрешены только в captured scope AND current policy. Если thread пополняется другим разрешённым контекстом, parent set объединяется под lock до публикации; user/model не задают родителей. Весь агрегат виден только при разрешении всех раскрываемых protected parents/fields; частичный preview/count не выдаётся по одному доступному родителю.

Охват: generic GraphQL/REST/search/count/export; dedicated AI history/thread/participant queries; workflow run detail/debug/step output; download/presigned URLs; SSE/agent stream/replay. До каждой новой выдачи current derived authorization; scope сохраняется в job, child workflow, stream and cache keys. Существующие байты не отзываются. Parent revoke/delete скрывает artifact, а не превращает detached результат в public; safe audit descriptor остаётся под отдельной admin policy. Runtime writers `agent-turn-recorder`, workflow-run state updates, chat-thread services не публикуют контент раньше scope. Предсуществующие обычные AI/workflow объекты сохраняют независимо реализованную baseline private policy (§15.13), а новые omni artifacts получают дополнительный scope. Worker/system principal не отменяет пользовательский read guard.

T08/T21/T25: C имеет workflow/agent/thread grant, но не conversation или один из CRM parents — list/detail/parts/raw state/error/export/search/SSE/files не раскрывают контент/labels/count. A с полным доступом видит результат; revoke midstream останавливает следующую выдачу. Снятие own artifact predicate — отрицательный контроль. Проверяется сохранение результата tool и model response, не только входной payload.

### 15.13 Независимость прав от Enterprise runtime

Факт pinned source: обычный build-row-access-policy импортирует Enterprise-marked buildRecordShareGate/другие helpers. Отсутствие ключа не означает, что вызовы не выполняются, а отсутствие header у вызывающего файла не определяет лицензию его зависимостей. Корневой LICENSE выделяет marked files в Commercial License, отдельно описывает production и development/testing. Это inventory фактов по тексту выбранного снимка, не утверждение о правовом статусе текущего демо. Решение D-18 остаётся: собственная реализация, без коммерческой runtime-зависимости и без снятия license gate.

В первом patch ROB-764 создаются baseline manifest известных Enterprise-зависимостей и CI no-new-dependency check (direct/transitive imports, DI и dynamic imports); он не означает готовности свободной сборки. ROB-766 начинает полную замену и замыкает manifest для free runtime: direct/transitive imports, DI registrations и динамические imports всех Enterprise-marked paths, реальные guarded/unguarded call sites. Вместо ссылки на record-share проектируется независимый `OwnBaselineReadabilityPolicy` плюс собственный row/action ACL. Требования к baseline: OPEN всё равно требует object/field grants; PRIVATE требует explicit own principal/resource grants; INHERITED требует разрешённого полного набора parents и field grants; SYSTEM закрыт обычным пользователям, разрешается только ограниченному audited purpose. Detached/unknown metadata не становится open. Используются собственные core grants и metadata declarations; Enterprise implementation/SQL/compiler не копируются. Уже существующие private данные не открываются при замене: bootstrap/migration собственных grants из проверенных владельцев и author links, неоднозначные ownership → deny+report до enable. Штатный email/AI/workflow функционал проходит fixture regression; все private object types инвентаризуются, не только omni.

Своя политика интегрируется на обычных разрешённых ORM/query entry points; Enterprise-marked providers/imports не включаются в выбранный production execution path и bundle вместо подмены ключей/feature flags. Возможность собрать такой runtime подтверждается статическим import/DI manifest и тестовой сборкой; если найдена неучтённая зависимость, release blocked до собственной замены/пересмотра состава, не silent fallback. Это явная дополнительная часть ROB-766, а не обещание, что текущая upstream free сборка уже независима. Общая архитектура/план могут быть готовы к реализации при обязательном fail-closed G18, но production только после полного manifest/test evidence.

T20: Enterprise providers отсутствуют либо инструментированы в test-only варианте на throw при вызове; own ACL PRIVATE/INHERITED/artifact isolation остаётся рабочим. Проверить actual startup/module graph, read/write/search/relations и default seed приватных объектов, не только отсутствие Enterprise key. Отдельно проверить effective baseline/own intersection, нет allow-all при unavailable policy. Upstream обновления проходят manifest diff. LICENSE/notices сохраняются; права распространения каждого заимствованного файла проверяются до публикации runtime.

### 15.14 Отправитель × режим диалога

Определение: [access-control — sender-mode](contracts/access-control.md#sender-mode).

Определение: [access-control — takeover](contracts/access-control.md#takeover).

### 15.15 Policy epoch и режимы блокировок

Определение: [access-control — epochs](contracts/access-control.md#epochs).

Определение: [access-control — lock-protocol](contracts/access-control.md#lock-protocol).

Export/SSE: короткая транзакция авторизации/выборки каждой страницы; после отпускания блокировки уже выбранные/отправленные байты не обещают отзываться. Перед новой страницей/пакетом — актуальная policy; export download повторно проверяет полный resource scope файла. Revoke relevant parent прекращает дальнейшую выдачу, unrelated epoch increment не рестартует export с нуля. Queue cursor связывает principal/scope и source position, epoch служит для recheck, не для безусловного reset. T10/T31: unrelated target edits не вызывают starvation/export restart; relevant revoke blocks; два merge начинают UPDATE, deadlock не возникает от lock upgrade; error retry остаётся bounded.

### 15.16 Pull истории и единый transport schema

Контрактный артефакт ROB-764 реализован в LOG-026: [versioned JSON Schema envelope v1](../../../packages/twenty-server/src/modules/omnichannel/contracts/omni-incoming-envelope-v1.schema.json) и [ограничения текстовой порции](../../../packages/twenty-server/src/modules/omnichannel/contracts/README.md), синтетические fixtures Telegram/MAX; единственный нормативный перечень полей, используемый adapter/server tests. `origin`/workspace/actor/grants отсутствуют во внешнем event и запрещены (additionalProperties false на соответствующем уровне); direction/sourceVariant/native-key version/sourcePosition/capture generation определены в schema. routeGeneration означает immutable capture generation, не новый owner при replay. Imports используют отдельный pull response, не поддельный live envelope.

ROB-768/770 добавляют `fetchHistoryPage(importBatchId,binding,providerChatId,sourceType,cursor,window,limit,expectedAccountIdentity)` Twenty→Connector. Credential purpose=history.read, scoped binding/chat/batch/expiry, без send/route management; server job не передаёт его browser/model. Connector выбирает native Telegram `/v1/history`, MAX history adapter либо immutable archive snapshot; не произвольный URL из клиента. Native identity/expected account сверяется до и после чтения. Текущие исследованные native adapters ограничивают окно 24 ч и limit запроса до 100 (MAX дополнительно ограничивает результат до 30); worker дробит диапазон, не предполагает больший capability. Rate limit/temporarily unavailable → checkpoint сохраняется и bounded retry; 410 journal gap/identity mismatch → paused/report, не ложное complete.

Response: source instance/snapshot version, account identity, window, opaque nextCursor, hasMore/completeness/gaps, canonical pageHash, items с sourcePosition/native key/version/direction/variant/provenance и attachment references. Native history не является snapshot: повтор той же страницы может показать edit; pageHash фиксирует конкретный ответ, не вечную неизменность провайдера. Job durable сохраняет page receipt/items прежде обработки, cursor продвигается только после application всех items; crash повторяет сохранённую страницу, overlapping subsequent pages дедуплицируются ключами/ревизиями. Пара `(batch,requestCursor,responseHash)` различает полученные варианты; изменённый повтор не переписывает прежний receipt. Для immutable archive изменение hash — corruption/conflict. Неподтверждённые SaleBot IDs сохраняют legacy namespace.

Только Twenty import job назначает trusted origin=history_import, проверяет current import permission на каждой batch и вызывает общий transactional domain service; внешний источник не может вызвать business suppression сам. File download uses bounded protected media contract. Stop/revoke сохраняет cursor, новые запросы и применение страниц прекращаются по policy fence; нет изменения live activation boundary из истории. T11/T16: оба канала native/archive pull, timeout после page persistence, expired credential, changed response, concurrent live/edit/import, resume без duplicates/effects и explicit completeness report.

### 15.17 Терминальные workflow и CAS сделки

Определение: [workflow-execution — design-22](contracts/workflow-execution.md#design-22).

Определение: [workflow-execution — runner-terminal](contracts/workflow-execution.md#runner-terminal).

Opportunity CAS: core `CrmRecordRevision(workspaceId,objectMetadataId,recordId,revision bigint)` UNIQUE триплет; migration ROB-766, без нового стандартного workspace поля. Existing live record без строки имеет read token 0; первый writer под policy/CRM locks вставляет строку с conflict-safe UNIQUE и перечитывает её. Любая изменяющая Opportunity операция (domain transition, generic API, AI/workflow/import/merge/restore и зарегистрированный direct writer) увеличивает revision в той же транзакции с update+audit. Для transition сначала own authorization и SELECT current row FOR UPDATE, затем сравнение expectedRevision; mismatch=conflict без раскрытия hidden записи. Revision не обновляется и не коммитится отдельно. Generic writers сохраняют свой API, но всегда bump token; batch lock order единый. Delete/restore не сбрасывает revision, survivor merge увеличивает свою; UUID reuse запрещён.

Queries возвращают current core revision рядом с authorized Opportunity projection; клиент не выводит её из updatedAt (потеря precision и несколько updates/transaction не проблема этого варианта). До включения transition все writers инвентаризованы и gated; неучтённый raw writer блокирует activation, не делает token декоративным. T30: two clients одинаковый token → одна transition; generic update между read/transition → conflict; rollback не меняет token; concurrent first-write, delete/restore/merge, cross-workspace denial.


### 15.18 Общие потребители, метаданные аккаунтов и действие workflow

**Независимый runtime — решения по семействам, ROB-764/766.** Зафиксированные call sites: WorkspaceRepository (row/readability и validation rules), CommonCreateManyQueryRunner (ShareWithService), ObjectRecordEventPublisher, CallWebhookJobsJob, CallDatabaseEventTriggerJobsJob (RecordAccessPolicyService), WorkflowDatabaseEventTriggerListener, CallAgentDatabaseEventTriggersJob, PendingWakeUpDatabaseEventListener, RecordShareOwnershipTransferService в UserService/workspace-member-delete-one hook, workflow-run-record-share, agent-chat-sharing, CoreEngineModule (RecordShareModule/RowLevelPermissionModule). Это исходная задолженность зависимостей, не новые права собственного кода.

| Семейство | Решение для production без подписки | Проверка |
|---|---|---|
| ORM readability, own row/field policy и аудит | Собственная реализация §7/15.12/15.13, обычные object/field grants сохраняются | T08/T20 PRIVATE/INHERITED/SYSTEM, read/write/relations |
| SSE, webhook, logic-function, DATABASE_EVENT workflow, agent-trigger и pending-wake-up events для Person/Company/Opportunity и других защищённых объектов | Собственный общий event admission: current principal подписчика/интеграции/приложения workflow/агента, workspace, object/field + baseline + own row grants. Источник с system principal не передаёт полномочия получателю. Проверка при доставке; отсутствие явного principal/scope → deny. Отдельный payload projection без hidden before/after fields и related labels; revoke/epoch fence до отправки | T08/T20: разрешённый получатель получает safe projection, чужой не получает PRIVATE событие, включая retry после revoke, DATABASE_EVENT workflow/agent trigger/wake-up и member delete/ownership transfer |
| Raw omni events | По-прежнему подавлены; только явный typed DomainEvent consumer с выданным scope, G16; общий event admission не разрешает omni wildcard delivery | T14/T16, отрицательный контроль suppression |
| Enterprise record sharing, ShareWithService/create-many, RLS predicates, validation-rule engine, sharing workflow runs/agent chats | Не переиспользовать. Enterprise entry points/UI/DTO options явно unavailable; не принять shareWith/enterprise predicate и молча проигнорировать. RecordShareOwnershipTransferService заменяется own grants migration/revoke при удалении/переносе сотрудника с policy epoch и fail-closed unresolved owner; пользовательские данные не удаляются каскадно. Собственные resource grants и AutomationArtifactScope заменяют нужные права/видимость; schema/business validation/DB constraints остаются. Неприменяемые enterprise validation rules не становятся собственной «бесплатной» функцией | T20: no imports/DI calls, explicit unsupported error; обычные create-many/AI/workflow работают с собственной политикой |

С первого patch ROB-764 CI сравнивает текущий import/DI graph с зафиксированным baseline: новая зависимость от Enterprise-marked файлов запрещена. ROB-766 удаляет baseline dependencies по указанным семействам и проверяет изолированную сборку; до этого стадия разработки не объявляется production-ready. До удаления функций снять read-only feature inventory текущего экземпляра: config/metadata/counts правил, shares, subscriptions/webhooks/logic-function triggers и права владельцев без текстов сообщений/секретов. На дату плана использование этих функций в live экземпляре **не установлено**; отсутствие ключа не считается отсутствием использования. Используемая функция не отключается молча: требуется согласованный перенос на собственный контракт и regression fixture либо исключение её использования владельцем, иначе G18 блокирует замену/выпуск. Неподдерживаемая migration не расширяет доступ. Manifest плюс T20 отсутствующих/throw providers обязательны для обычных CRM событий и create-many, а не только omni.

**Метаданные account binding, ROB-766.** WORKSPACE scope остаётся техническим ownership, не разрешением чтения. ConnectedAccountMetadataService.findUsableByCaller фильтрует omni-bound аккаунты по own binding.read; verifyUsableByCaller также проверяет это право на direct ID. MessageChannelMetadataService и MessageFolderMetadataService наследуют тот же guard; generic/nested loaders, search/count и UI account selectors включаются в inventory. Отсутствующий grant → не раскрывать handle/name/channel/folder/count. Администрирование требует отдельного binding.manage и штатного permission, владение custodian не создаёт автоматического bypass. Штатный startChannelSync выбирает только EMAIL; этот путь не используется для APP/omni и не превращается в собственный connector control. T08: A с grant видит, C без grant не получает данные через list/direct ID/channel/folder; email WORKSPACE behavior сохранено.

**Атомарные metadata mutations, ROB-764.** DB-only account/channel mutation берёт shared native ownership fence в начале отдельной READ COMMITTED transaction, затем locks account IDs в стабильном порядке, затем channel row. После channel lock parent обязан совпадать с предварительно найденным; иначе явный conflict без записи. Ownership source/destination и APP application/provider/scope/custodian проверяются свежим чтением через тот же manager, который делает mutation. Native bootstrap использует exclusive fence. Generic channel create не принимает relation-shaped workspace/connectedAccount/messageFolders и не создаёт channel под owned/foreign-workspace account. APP missing/unreachable ответы остаются неотличимыми. Delete events только после успешного COMMIT; ordinary legacy events этим не становятся durable outbox. Общий core transaction owner использует свежий QueryRunner и runner.manager; неподтверждённый rollback/commit уничтожает connection вместо возврата в pool, commit/release uncertainty возвращается явным UnknownError. Workspace и metadata используют один этот owner с разными режимами fence. Network lifecycle и resolver effects должны соблюдать ту же границу, но требуют своих owners; наличие DB-only helpers не означает покрытия этих путей.

**Штатные писатели participants, ROB-764.** MessageParticipantWorkspaceMemberListener → MatchParticipantService.matchParticipantsForWorkspaceMembers включается в writer inventory. В обеих ветках select/update (снятие старого workspaceMemberId и matching нового email) omni participants исключаются до записи по принадлежности к omni MessageLink/channel; использовать принцип existing withoutAppChannelParticipants, проверить точный join в реализации. Аналогично контролируется people rematch. Обязательный inventory включает MessageParticipantPersonListener, ParticipantTargetPersonListener, ReconcilePersonCompanyTargetsJob и reconcileTargetsForPeople, MessagingMessageCleanerService.reconcileMessageThreadTargets, а также все вызовы reconcileParticipantTargets (включая смену pointOfContact). Persisted omni ownership исключается до вычисления desired targets и до batch writes; email/calendar продолжают сверяться. T05/T23: companyId/pointOfContact change, mixed email+omni batch → 0 omni target mutations/сырых events, прежние email results. Repository domain-only guard остаётся последней защитой, но job не должен пытаться записать omni и откатывать весь смешанный email batch. Удаление участника/смена email не меняет исторического автора. T05/T22/T14: смешанные email+omni записи, смена email и удаление member → email rematch корректен, 0 omni mutations и 0 generic omni events.

Определение: [workflow-execution — send-action](contracts/workflow-execution.md#send-action).

Определение: [sending-ui — command-states](contracts/sending-ui.md#command-states).


### 15.19 Полный жизненный цикл omni workflow и CAS управления

Определение: [workflow-execution — trigger-registration](contracts/workflow-execution.md#trigger-registration).

Определения: [catalog](contracts/workflow-execution.md#design-39), [точки интеграции](contracts/workflow-execution.md#catalog-integration).

Определение: [workflow-execution — runner-recovery](contracts/workflow-execution.md#runner-recovery).

Определение: [access-control — control-cas](contracts/access-control.md#control-cas).

**Fork metadata (ROB-764).** Новые fork entities/columns не помечаются @WasIntroducedInUpgrade и другими upstream upgrade-aware decorators с fork-only command IDs: UpgradeAwareEntityMetadataAdapter сверяет их только с upstream sequence. Это не обходится добавлением фиктивной команды в upstream sequence. Наличие/версию fork schema проверяют собственный ledger/preflight/runner до доступа бизнес-кода; startup fail-fast при несогласованности. T33 включает static scan decorators, построение metadata graph и реальный restart на пустой и ранее обновлённой базе, плюс отказ на незавершённой fork migration.

Определение: [workflow-execution — workflow-ids](contracts/workflow-execution.md#workflow-ids).

Определение: [workflow-execution — coverage](contracts/workflow-execution.md#coverage).

Определение: [workflow-execution — cancellation](contracts/workflow-execution.md#cancellation).

Определение: [workflow-execution — command-cancellation](contracts/workflow-execution.md#command-cancellation).

### 15.20 Покрытие обычных триггеров и внутренних повторов

Определение: [workflow-execution — producer-inventory](contracts/workflow-execution.md#producer-inventory).

Определение: [workflow-execution — hidden-retry](contracts/workflow-execution.md#hidden-retry).

T19 contention gate начинается уже в ROB-766 до массового подключения mutation kernels и UI: измерить репрезентативные параллельные reads/stage/assignment/target mutations на изолированной test DB, зафиксировать workload, p95/p99/wait/throughput и согласованный G13 capacity target до activation. При непрохождении остановить расширение интеграции и отдельно пересмотреть protocol с equivalence/revoke tests; не включать непроверенный split epoch или убрать locks. ROB-771 повторяет нагрузку полного продукта. T19 измеряет WorkspacePolicyState FOR SHARE/MultiXact contention при параллельных чтениях и policy mutation на выбранном масштабе; correctness guards не снимаются ради throughput.

### 15.21 Итоги планового разбора: epochs, reply commit, restore access

Определение: [access-control — epoch-tests](contracts/access-control.md#epoch-tests).

Определение: [workflow-execution — design-31](contracts/workflow-execution.md#design-31).

G12/§15.4: restore стартует в maintenance, с внешним fence UI/API/SSE/worker доступа, не зависящим от восстановленной БД. До открытия — инвалидировать все восстановленные пользовательские/refresh sessions и API keys, заменить именно signing material авторизации (не ключи шифрования транспортных credentials), сохранить только отдельно проверенный admin recovery ingress. Сверить membership/roles/grants и последние revoke по защищённому внешнему access-change журналу/актуальному административному реестру вне restore set. При отсутствии свидетельства default deny и явное повторное назначение доступа; не считать восстановленные grants доказательством. Подключения/транспорт остаются fenced по §15.4. T18/T29: уволенный после snapshot principal и старый API key не читают данные ни до reconciliation, ни после снятия fence без нового grant. Это runbook будущего restore, не текущая ротация секретов.

TrashCleanup.deleteSoftDeletedRecords включён в lifecycle/writer/audit inventory: нельзя generic bypass hard-delete omni Message/Thread/Participant/owned associations. Destroy Person/Company с omni references проходит domain lifecycle adapter: до SQL delete unbind ExternalIdentity и безопасно очистить links без удаления истории/author snapshots, audit destroy и mutation в одном executor. DB SET NULL не заменяет этот adapter. Ordinary cleanup сохраняет свой путь; T22 включает mixed email/omni, dangling identity, destroy rollback и 0 raw omni events.

LOG087 реализует внутренний административный adapter `destroyOmniCrmParent`: полный fingerprint родителя, exact identity/target revision manifests и actor-key receipt; same-executor unlink/delete/audit, current-admin replay после удаления. Оставшиеся native/custom FK references отклоняются с полным rollback до появления их scoped audit writers. Generic hard destroy связанных родителей по-прежнему отклоняется; публичный routing/ACL и governed events вводятся следующими этапами.
TrashCleanup пропускает protected native/parent records теми же ownership helpers,
двигает keyset по (deletedAt,id) включая полностью protected страницы и считает
фактически удалённые строки. Timestamp cursor сохраняет точность PostgreSQL;
удаление повторно проверяет retention predicate после row lock, чтобы не удалить
параллельно восстановленную запись. Каждая страница — отдельная короткая транзакция
под shared ownership fence; пропуск не считается успешным destroy или audit.

### 15.22 Закрытие диалога и автоответы

Определение: [access-control — closed-status](contracts/access-control.md#closed-status).

### 15.23 Полнота event roots, policy writers и lifecycle материалов

Определение: [workflow-execution — design-26](contracts/workflow-execution.md#design-26).

Определение: [access-control — policy-writers](contracts/access-control.md#policy-writers).

Определение: [access-control — auto-admission](contracts/access-control.md#auto-admission).

Outgoing AttachmentLink при подтверждённой связи Command→canonical Message атомарно меняет родителя: commandId=NULL/messageId=canonicalId в той же transaction receipt/reconciliation+MessageLink+audit. XOR никогда не нарушается в committed state. File/metadata/provenance сохраняются, ACL наследуется от того же conversation/current authorized parent; новый общий доступ не появляется. Echo-before-receipt вызывает тот же idempotent attach operation; UNIQUE(parent,canonical attachment key) предотвращает дубли, unknown mapping quarantine без потери файла. Command retention не удаляет Message-owned attachment. T15/T17: pending→message, echo-before-ACK, retry/rollback, current ACL/download и retention.

G12 restore signing/encryption preflight: прочитать фактическую конфигурацию ключей без вывода значений. В upstream resolveEncryptionKeysOrThrow primary=ENCRYPTION_KEY либо APP_SECRET, JWT также зависит от APP_SECRET. Если отдельного ENCRYPTION_KEY нет, ДО ротации APP_SECRET закрепить прежний effective encryption key как ENCRYPTION_KEY в защищённой конфигурации; сохранять нужный FALLBACK_ENCRYPTION_KEY. Проверить decrypt контрольной записи, затем изменить signing APP_SECRET и проверить одновременно invalid old session и decrypt existing secrets. Если preflight/decrypt не пройдены — maintenance/access fence остаётся, ротацию/открытие не продолжать. Секреты не попадают в Git/отчёты; это инструкция будущего restore, сейчас ключи не меняются. T18 воспроизводит explicit key и legacy fallback варианты.

G01/G04 до активации автоответов явно выбирают допустимую CRM информацию в общей клиентской переписке: существующий conversation reader видит уже отправленный текст, последующий revoke CRM не может забрать отправленные клиенту байты. Нельзя выдавать это за обход прямого query ACL; при неподходящей модели ограничить разрешённый output scope/читателей до activation. WorkspaceService/DestroySoftDeletedWorkspaceJob входят в destroy inventory, T22 проверяет общий запрет неразрешённого удаления omni истории. Workspace admission до внешних effects выполняется короткой транзакцией под exclusive native ownership fence: retained core omni строки запрещают удаление; иначе сохраняется deletedAt без изменения ранее выданного timestamp. Bootstrap под тем же fence отвергает missing/deleted workspace до первого policy INSERT. После admission блокировка отпускается до вложенной cleanup; cache инвалидируется, billing проверяется до membership deletion. Ошибка cleanup не снимает deletedAt; повтор использует ту же дату для uninstall token. Direct schema DROP повторяет retained/tombstone checks в своей короткой транзакции. Неизвестный COMMIT прерывает cleanup и инвалидирует cache; uncertain connection уничтожается. Контролируемая очистка omni истории остаётся отдельной domain operation, не обходом этих guards.

Определение: [workflow-execution — design-41](contracts/workflow-execution.md#design-41).

### 15.24 Учёт посторонних отправителей и ожидаемый restore fallback

G11/G13 до активации каждого реального аккаунта требуют read-only inventory всех отправителей/destinations и доказательства их transport ownership/journal provenance. Это не интеграция с роботом и не изменение сторонних сервисов. Один sender при cutover означает один CRM-dispatch owner данного account/generation; прочие разрешённые non-CRM отправители должны быть перечислены, не молча присвоены CRM. Несовместимые конкурирующие владельцы/неизвестные источники блокируют activation до разделения аккаунтов/устранения конфликта.

Provenance различает external_human, external_service и unresolved_external. external_service присваивается только trusted userbot journal evidence об исходном service principal, не полю входящего JSON, тексту или отсутствию Command. Все эти outgoing сохраняются без customer admission. Неопределённая correlation не становится human/service по догадке. До явной настройки externalServiceReplyPolicy в G11 используется консервативный pause/handoff после доказанного стороннего service send; исключения требуют выбранной account policy и проверок T24. Не добавляются автоответы на служебные сообщения или автоматический resume. Existing externalHumanReplyPolicy применяется только к доказанному human, а unknown остаётся visible reconciliation.

G12 restore также создаёт новый restoreIncarnation UUID в WorkspacePolicyState до снятия внешнего fence. Все execution references, protected cursors и permission snapshots закрепляют пару (restoreIncarnation,policyEpoch). Числовая эпоха может повториться после restore, но incarnation не восстанавливается из backup: новый UUID записывается до запуска readers/workers. Старые captured references/cursors отклоняются; authorized replay/reconciliation создаёт новый reference после текущей проверки grants, без автоматического повтора effects. T18/T29: старый reference с тем же numeric epoch, но старым incarnation → deny.

G12 runbook v1 прямо допускает отсутствие независимого полного access-change журнала: внешний access fence остаётся, восстановленные grants не доверены, проверенный recovery administrator заново назначает разрешения с audit. Это ожидаемый fail-closed recovery, а не «restore успешно открыл всем доступ». Writer отдельного внешнего журнала не обещан без соответствующего этапа/хранилища; его отсутствие не ослабляет default deny. T18/T29 проверяют оба варианта evidence available / evidence absent.


### 15.25 Session owner, restore ordering и служебные копии

Выбран план обновления существующего единственного процесса-владельца userbot session на аккаунт. Сессия Telegram/MAX не копируется в новый процесс и не используется одновременно двумя процессами. Исходники/тесты адаптера готовятся отдельно, но интеграционный rollout заменяет boundary в одном существующем владельце с сохранением durable journal. Это будущая явно согласованная операция ROB-768/771, не побочное изменение SaleBot/робота сейчас.

До switch boundary поддерживает explicit legacy CRM principal/generation 0, назначенный сервером только по прежнему аутентифицированному credential и account mapping; отсутствие generation само по себе не даёт legacy-доступ. Native session journal хранит owner/generation и cancel tombstones; центральный registry инициирует fenced/draining handshake, provider calls разрешены только при совпадении подтверждённых поколений обоих boundary. Switch CAS в userbot journal отключает legacy credential/implicit generation 0, затем подтверждается connector; промежуточное расхождение fail closed. Старый C без нового protocol после switch отклоняется у userbot, даже если обходит connector. AccountBinding Twenty по-прежнему имеет generation>0; 0 — только временная legacy transport qualification.

Rollback не возвращает generation 0 и не включает безусловно старые HTTP-вызовы: тот же journal, новое увеличенное поколение, rotated credential и generation-aware legacy adapter. Если он не квалифицирован, rollback остаётся fenced, без отправок; UI rollback сам transport не переключает. Прочие service principals учитываются отдельной allowlist/provenance по §15.24, не маскируются под legacy CRM. T11/T18 проверяют late unversioned C, bypass central endpoint, crash между двумя CAS, недоступный journal, cancel tombstone и rollback; для реального аккаунта нужны выбранные G11/G13 и окно вмешательства.

Определение: [sending-ui — fifo](contracts/sending-ui.md#fifo).

G10 retention/purge manifest включает все payload copies: receipt/envelope, event/dispatch snapshots, command bodies/reply/files, AI/workflow artifacts, captured_events и userbot/connector command journals. Эти operational payload не доступны business search/retrieval/AI; эти пути читают canonical content с tombstone/current ACL. Tombstone сразу прекращает выдачу, physical purge зависит от G10 и доказанного завершения/cancel pending effects. Purge заменяет payload защищённым tombstone/redaction marker, сохраняет минимальные keys/hash/outcome/provenance для dedup/reconciliation; старый replay не восстанавливает удалённый текст и не сбрасывает idempotency. Backups имеют отдельную согласованную retention, не обещается удаление всех копий при tombstone. T17/T32/T29 проверяют все перечисленные stores и replay после redaction; при недоступности внешнего store purge остаётся incomplete, не falsely completed.


### 15.26 Единые правила run identity, permissions snapshot и совместного UI

Определение: [workflow-execution — run-identity](contracts/workflow-execution.md#run-identity).

Определение: [access-control — read-authority](contracts/access-control.md#read-authority).

Определение: [sending-ui — human-stale-view](contracts/sending-ui.md#human-stale-view).

Определение: [access-control — lock-protocol](contracts/access-control.md#lock-protocol).

Определение: [sending-ui — timeline](contracts/sending-ui.md#timeline).


## 15.27. Начальные настройки и владельцы служебных проекций

**Durable config wake-up (LOG-039).** Отдельный BindingConfigWakeup хранит доставку `binding.config_changed` фиксированному служебному обработчику; это не workflow execution, поэтому фиктивные pinnedVersionId/executionId в ConsumerReceipt не создаются. Producer записывает строку вместе с проверенным событием и аудитом в одном commit; no-op/replay не создают вторую доставку. Для ранее созданных событий bounded reconciliation проверяет закрытую event schema и связывает оригинальный event, без синтетического нового события. Два FK не доказывают соответствие JSON payload и binding: consumer дополнительно проверяет `event.payload.bindingId === wakeup.bindingId`.

Claim выполняется короткой strict transaction под policy→binding→wakeup. Страница обработки использует отдельную strict transaction: текущие права и binding, существующий resume helper с parent→receipt locks, затем wakeup lock и финальный owner/token/DB-expiry CAS после receipt audit. Receipt transitions, audit и checkpoint коммитятся вместе. Неопределённый COMMIT не считается успехом: состояние восстанавливается read-back/lease recovery. Auth denial не превращается в grant или успешную обработку. Inactive binding не активируется; неизвестная handlerVersion блокируется с явной причиной. Событие означает перечитать текущие настройки, не восстановить прежние defaults. Смена generation сбрасывает cursor, но не меняет generation старых receipts.

Cursor хранит точный PostgreSQL timestamp с шестью дробными знаками и receipt ID. Вся просмотренная страница продвигает cursor, включая не подходящие строки. Подходящие строки, пропущенные из-за SKIP LOCKED или snapshot race, устанавливают needsRescan; флаг накапливается между страницами. Конец такого прохода очищает cursor и назначает bounded retry с начала. `completed` означает завершённый проход, не доказательство отсутствия всех blocked receipts. Periodic housekeeping запускает новые проходы по текущей конфигурации, чтобы подобрать поздние изменения. Без подключения scheduler/current grant provider внутренний API не объявляется работающим production recovery.

**Strict owner и housekeeping (LOG-040).** Существующий MessagingSaveMessagesAndEnqueueContactCreationService принимает закрытую команду claim/process/reconcile/rearm/housekeeping; principal, вложенные параметры и ссылки на authorizer фиксируются до загрузки workspace context. Каждая команда получает собственную strict native transaction; process требует обоих текущих разрешений wakeup/history.resume. `buildSystemAuthContext` лишь выбирает native workspace context и не заменяет grant. После подтверждённого rollback владелец отдельно пишет failed/denied attempt на проверенном binding; unknown commit/rollback/release не превращается в отрицательный аудит или слепой retry. Ошибки операции и failure-audit сохраняются вместе.

Housekeeping ограничен одним binding и одним rearm за вызов: при наличии blocked_config/configuration_missing receipt текущего generation и отсутствии незавершённого поддерживаемого wakeup выбирается последний completed handlerVersion=1 по времени/ID исходного DomainEvent. Время backfill row не меняет этот порядок. Возобновляется прежний wakeup с очисткой cursor; новое событие не выдумывается. Отсутствие события/подходящих receipts или наличие незавершённой работы возвращается явным результатом. Это ограничивает дублирующие проходы по одному binding; scheduler вызывает следующую короткую транзакцию отдельно, не держит locks между командами.

**Queue/mode при ingress.** AccountBinding создаётся inactive с nullable defaultQueueId; после создания OmniQueue того же binding и выбора G08 activation проверяет active queue и допустимых читателей. Входящий для нового Conversation под общим policy→binding→conversation порядком атомарно копирует defaultQueueId/defaultConversationMode. Нет валидной queue/config — receipt остаётся durable blocked_config с видимой ошибкой binding для администраторов, без Message/admission/скрытого NULL-диалога; повтор apply после исправления использует прежний receipt. Config/policy writer атомарно пишет durable DomainEvent(binding.config_changed); typed consumer bounded batches переводит blocked_config этого binding в retry по индексу (workspaceId,bindingId,state,nextAttemptAt), не создавая новых receipts. Periodic housekeeping также перечитывает blocked_config/current config, чтобы не потерять wake-up; повтор consumer идемпотентен, общий claim/apply контракт сохранён. Реальная activation требует ROB-766. До него ROB-764 использует только изолированные integration fixtures с test-only injected authorization и явным synthetic queue grant; это не runtime flag и не production bypass. Проектируемые ACL не объявляются работающими. Выключение/удаление любой queue с retained Conversations запрещено, включая закрытые/назначенные: сначала явный moveConversationQueue в активную разрешённую замену с policy/audit. Для большого набора перенос bounded batches, queue остаётся active до опустошения; финальная проверка под policy UPDATE исключает concurrent ingress/move. Default reference активного binding тоже требует замены до disable. Никакого скрытого переноса/потери доступа; изменения queue/grants/defaults — policy writers. Смена default действует только на новые диалоги; закрытый существующий сохраняет свою очередь, переоткрытие по G20. До выбора G04/G07 режим новой binding human; назначить default auto/assist можно только после соответствующих gates. T12: first inbound, concurrent default edit/queue disable, invalid config/recovery, first-message automation и closed inbound.

**Assignment.** ResourceAssignment — источник назначения; Conversation.assigneeMemberId — проекция единственного assignmentKind=primary_owner с principalKind=workspaceMember либо NULL. Один policy writer атомарно меняет canonical row/projection, controlEpoch/policyEpoch и audit; generic update проекции запрещён. Дополнительные team assignments не меняют primary owner. Участие хранится только в ConversationMember; отдельный ConversationReadCursor не меняет участие/назначения/права; changeParticipants пишет ConversationMember через один policy writer с audit/epoch. ResourceAssignment не имеет collaborator rows. Участие само по себе не даёт grant; права участников проверяются по G01. Даёт ли назначение read/reply — только G01/ResourceGrant; наличие проекции не самостоятельный grant. T10/T13: direct mutation denied, concurrent reassignment, rollback, актуальные grants.

**Аудит.** operationId — серверный стабильный ID одной логической domain mutation, не rootExecutionId/correlationId; две разные workflow mutations получают разные operationId, replay принятой mutation использует прежний. Для success eventKey детерминирован по workspace/operationId/resourceKind/resourceId/action; одна затронутая строка — один success на это действие. При повторных writes одной пары (resource,action) общий transaction audit context собирает первый before и последний after; owner flush-ит один redacted entry на пару тем же executor до COMMIT. Nested writers переиспользуют context, самостоятельный audited repository write создаёт его в собственной transaction; flush error откатывает все mutations. Это не afterCommit buffer. CREATE/UPDATE/DELETE имеют нормализованные разные action keys, UPSERT определяется по фактическому действию; root/correlation не дедуплицирует разные domain mutations. Отказ после rollback имеет отдельный server attemptId в eventKey, чтобы попытка не конфликтовала с последующим success. Key/hash конфликт отклоняется, не overwrite. Один root workflow/массовая операция связывает разные mutations через correlation/causation. T06: lost commit ACK, duplicate callback, два изменения одной строки одним action внутри merge/bulk дают один aggregated success с верным before/after, flush failure откатывает всю transaction; разные шаги с разными operationId сохраняют отдельные записи, bulk audit содержит только actual rows.

Для native `crmRecord` ключ и security descriptor дополнительно включают `objectMetadataId`: одинаковые UUID записей разных объектов не объединяются. Поля native diff обозначаются fieldMetadataId, значения до явной allowlist не сохраняются. PostgreSQL NUMERIC и вложенные значения сравниваются без преобразования точных чисел в JS number. LOG089 вводит внутренний opt-in `nativeAudit` для Company scalar update/updateMany с одним strict owner; это ещё не автоматическое покрытие публичного ORM. Без domain command receipt повтор уже закоммиченного native operationId запрещён под общей workspace/operation блокировкой до callback; после подтверждённого rollback повтор допустим. Unknown outcome не означает retry и не записывается как failed. Общий replay принятой команды по receipt остаётся отдельным обязательным контрактом; operationId сам по себе его не реализует.


Системные createdAt/updatedAt/deletedAt сохраняют исходную writability/permissions,
не запрещаются audit guard. Native snapshots включают даты; createdAt сравнивается
всегда. Автоматический updatedAt исключается только из diff и лишь если все writes
данной resource/action были implicit. Явный nonundefined updatedAt хотя бы в одном
write навсегда включает сравнение фактических first-before/last-after для этой операции;
batch классифицирует каждый authoritative ID отдельно. Внутренний metadata field ID
suppression не сохраняется в audit payload/descriptor. FILES null сохраняет прежний
native-only clear без core File cleanup; [] остаётся removal. LOG093 проверяет это
реальными validators/processor и PostgreSQL; public numeric transformer не меняется.

Для core File изменения в native FILES update используется отдельный `crmFile`, action update,
resourceId=File ID и exact fileParent(objectMetadataId,recordId,fieldMetadataId). Parent
берётся из authoritative locked native records/metadata, не из payload.id. Scope должен
сохраняться после отвязки. Settings/deletedAt сравниваются по actual final DB snapshot,
значения редактируются; path/labels/contents не копируются. File rows блокируются по ID
после native parent locks, workspace/field/temporary/status проверяются заново. Все
core writes используют тот же executor и проверенные actual written parents; actual
parent FILES список и final File state проверяются до commit. Missing/deleted/foreign
File reference и неоднозначные владельцы отказаны, не исправляются молча. Физическое
storage deletion остаётся отдельным lifecycle. LOG092 реализует внутренний array-input
update путь; LOG093 сохраняет public null/timestamp parity, LOG094 подключает public UPDATE.

Common UPDATE_ONE/UPDATE_MANY для exact standard Company/Person/Opportunity создают
strict native audit owner автоматически. Самостоятельный API-вызов получает новый
server operationId; повтор HTTP не является receipt replay. Входящий scope принимается
по identity регистрации native owner, действующему lifecycle, workspace и actor; копия,
чужой либо завершённый scope не допускают unscoped fallback. Mutation и nested relation
reads используют его executor. Root getters/visibility и awaited post-query hooks
выполняются после COMMIT; ошибка hook не отменяет committed audit. Inherited hooks
откладываются владельцем. LOG094 проверяет это через реальные public runners и PG;
full HTTP authentication, CREATE/merge и остальные owners этим не объявляются готовыми.

LOG095 расширяет внутренний native owner на non-file CREATE этих стандартных объектов.
Успех определяется actual INSERT RETURNING IDs; skipped conflicts не дают audit.
Снимок after читается из БД, включая defaults, before=null. Служебный RETURNING id
нужен независимо от caller selection и не расширяет raw/generatedMaps полями.
Mixed save/upsert захватывают вход до lookup, poisoned owner не коммитит частичный
результат при перехваченной ошибке. Create→update остаются разными action events.
LOG096 добавляет FILES в тот же executor: parent UUID захватывается до enrichment,
File lifecycle применяется только к actual INSERT IDs. Пропущенные planned File rows
проверяются по полному DB snapshot и должны остаться неизменными. Проверяются все
FILES поля after row, включая null/empty/omitted; неожиданные attachments или
подмена parent из trigger/default приводят к rollback. Public CREATE требует
следующего покрытия nested/shareWith/upsert; этот контракт пока внутренний.

LOG097 расширяет внутренние create/update на обычные local non-standard application
objects. Authority — реальные workspace/object/application identifiers, а не удалённый
upstream флаг isCustom. Требуются !isSystem, !isRemote, совпадение workspace/object
shape и canonical table name; standard names/IDs вне исходных трёх объектов отказаны.
Это не допуск для recordShare/workflow/calendar/message и не включение public custom
autoowner. Цепочка standard→custom→standard использует один явный native scope.
