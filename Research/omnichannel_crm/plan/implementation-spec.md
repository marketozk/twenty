# Подробная спецификация реализации — весь проект

26.10.2026. Проект плана для независимого кроссревью; новый runtime-код не написан. Baseline документов `475e27531d6a2b8d04327223d73afd8767f60a07`, исходники Twenty `729f6236126eddaa68d176fb766bc349b19de11d`. Документ детализирует этапы 1–7, не разрешает реальные отправки или переключение SaleBot. Раздел 15 содержит обязательные уточнения первого review; при расхождении с прежними краткими формулировками применяется более точный контракт раздела 15.

Контракт: [требования v0.6](../requirements.md), [потоки](../design/02-behavior.md), [модель](../design/05-models.md), [API](../design/06-api.md), [аудит](../design/08-audit.md). Доказательства по коду: [integration-map](../implementation/integration-map.md), [транзакции](../implementation/transactions-audit-source.md), [доступ](../implementation/access-source.md), [ИИ/workflow](../implementation/ai-workflow-source.md), [коннекторы](../research-connectors.md).

## 1. Границы и модель отказов

Полная замена SaleBot для общения: Telegram/MAX через отдельные юзерботы, совместный inbox менеджеров, CRM-права, аудит, автоответы/действия ИИ, workflow и импорт. Нет интеграции с тендерным роботом или обхода Enterprise gate. Внешние группы мессенджеров и дополнительные Bot API аккаунты не считаются выбранными; совместная работа менеджеров обязательна.

Модель отказов для review: concurrent duplicate/reordered events; crash процесса в любой точке; недоступность одной зависимости; timeout/потеря ответа; Redis loss при сохранной PostgreSQL; revoke/takeover/import-live race; восстановление известного backup с reconciliation. Одновременная утрата данных и всех копий, захват root или ложь провайдера вне гарантии. При неизвестном исходе внешнего send — unknown, не обещание exactly-once доставки.

Один существующий экземпляр CRM. Постоянные automated tests используют временную БД/namespace/storage с проверкой имени/адреса до reset. Это не второй постоянный экземпляр и не предварительный выбрасываемый прототип. Отказ от нового backup при выполненном обновлении не означает отказ от будущей защиты клиентских данных.

Различаем: факты существующего кода; решения плана; результаты тестов новой реализации. Сейчас третьего нет. Продуктовые настройки остаются gates раздела 13; не выдаём fixtures за реальные роли/аккаунты пользователя.

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
| AccountBinding | platform, connectorInstanceId/accountId, connectedAccountId, messageChannelId, routeGeneration bigint, status, capabilitiesVersion/json | UNIQUE(workspaceId,platform,connectorInstanceId,accountId), UNIQUE(workspaceId,messageChannelId), generation>0; transport registry дополнительно запрещает двух владельцев аккаунта |
| ExternalIdentity | bindingId, providerPeerId, personId nullable, verificationSource | UNIQUE(workspaceId,bindingId,providerPeerId); username не ключ |
| Conversation | bindingId, providerChatId, messageThreadId, assigneeMemberId nullable, status, mode, revision/controlEpoch bigint, policyVersion | UNIQUE(workspaceId,bindingId,providerChatId); index workspace/assignee/status/updatedAt |
| ConversationMember | conversationId, workspaceMemberId, lastReadSequence bigint | UNIQUE(workspaceId,conversationId,workspaceMemberId); участие не заменяет grant |
| MessageLink | conversationId, bindingId, rawNativeMessageId, nativeMessageKey/version, messageId, providerRevision/sourcePosition nullable, outgoingCommandId nullable | UNIQUE(workspaceId,bindingId,conversationId,nativeMessageKey), UNIQUE(workspaceId,messageId) |
| IncomingReceipt | bindingId, eventId, kind/version/generation, canonicalPayloadHash, validatedEnvelope jsonb, state, attempts, nextAttemptAt, leaseOwner/token/until, resultId/errorCode | UNIQUE(workspaceId,bindingId,eventId); index state/nextAttemptAt/leaseUntil |
| OutgoingCommand | conversationId, actorKind/id, initiatingActorId, idempotencyKey, payloadHash/jsonb, expectedEpoch/policyVersion/generation, state, connectorJobId, leaseToken/until, nextAttemptAt, statusRevision | UNIQUE(workspaceId,actorKind,actorId,idempotencyKey); id=commandId; target/payload immutable |
| DomainEvent | eventId=id, conversationId nullable, kind, origin, causation/rootExecutionId, conversationSequence, payloadVersion/jsonb | UNIQUE(workspaceId,conversationId,sequence) для conversation events |
| ConsumerReceipt | eventId, consumerId, executionId, state, attempt, leaseToken/until, nextAttemptAt | UNIQUE(workspaceId,eventId,consumerId); executionId неизменен при retry |
| RouteActivation | bindingId, activationVersion, sourcePositionType, boundary jsonb | UNIQUE(workspaceId,bindingId,activationVersion); immutable boundary |
| AutomationAdmission | bindingId, messageLinkId, effectKind, activationVersion, trustedSourcePosition, eventId | UNIQUE(workspaceId,bindingId,messageLinkId,effectKind,activationVersion) |
| InternalNote | conversationId, authorMemberId, body, idempotencyKey | Отдельная операция без transport serialization |
| AttachmentLink | conversationId, messageId XOR commandId, fileId nullable, providerAttachmentId, state/hash/error | Ровно один родитель; уникальность provider attachment в родителе |
| ImportBatch | bindingId, sourceType/snapshotRef/range, checkpoint/counts jsonb, state, generation/activationVersion | Checkpoint после durable ACK страницы; secrets вне batch |

InternalNote/Attachment/Import можно мигрировать в своих этапах, но идентификаторы контрактно согласованы сейчас. Базовая схема и writer CrmAuditEntry для собственных mutations входят в ROB-764. ROB-765 расширяет покрытие CRM, ROB-767 добавляет чтение/UI; первый этап не ждёт своего будущего audit dependency.

SQL/up/down первоначально генерируются штатным database:migrate:generate, затем изолируются в fork-only registry по §15.5; одного нового timestamp в 2-52 недостаточно. Upstream cursor не изменяется. Tests: пустая/заполненная fixture, повтор upgrade, down на пустых новых таблицах. Down непустых operational tables не выполняется автоматически. Additive schema, без backfill старых email и автоматического изменения существующих каналов; объёмная миграция существующей таблицы требует отдельной проверки lock time.

## 4. Приём и отправка — ROB-764/768

Проектируемые transport endpoints: POST /v1/omnichannel/events, GET /v1/omnichannel/receipts/:id. Browser — domain GraphQL из design/06-api. Envelope v1: eventId, accountBindingId, routeGeneration, kind, providerChatId/messageId, occurredAt, sourcePosition(type,value), payload. Import job вызывает внутренний service; внешний JSON не назначает workspace/actor/personId/policy/import origin.

Binding credential: keyId + HMAC SHA-256(method,path,timestamp,raw-body hash), constant-time compare, configured timestamp window/body limit. Replay старого события подписывается заново текущим timestamp, eventId сохраняется. Ключ — encrypted secret/reference, rotation overlap ограничен, revoke блокирует новые запросы. Limiting credential/workspace/global queue; 429/503 до ACK, Retry-After. Неизвестная schemaVersion/слишком большой body отклоняются до ACK. Поддержанная версия с необработанным kind может быть durable quarantined с явным статусом. Hash семантического валидированного envelope включает kind/target/generation, исключает transport signature/timestamp.

Ingress: validate/auth → transaction lock binding/generation → INSERT receipt или сравнить hash при conflict → audit accepted → COMMIT → 202 receiptId/state. Одинаковый повтор возвращает тот же receiptId/current state (200); changed semantic payload=409, original receipt сохраняется. ACK означает ответственность CRM за replay, а не готовый Message. Отказ/неизвестный commit не даёт ложный ACK; клиент повторяет eventId.

Worker: короткий claim через FOR UPDATE SKIP LOCKED увеличивает leaseToken. Общая workspace transaction проверяет leaseToken, binding/generation, locks conversation/identity; затем scope-aware Message/participants/targetsOnly + link + receipt applied + conversation revision/sequence + admission/event + audit. Все writes через scope executor; injected independent repository запрещён. Второй worker после lease expiry может reclaim; старый token не может commit. Postcommit callback только ускоряет enqueue; durable job/event хранится в PostgreSQL.

Conversation upsert по binding/chat с последующим row lock. Unknown identity сохраняется unbound, без угадывания Person по имени; link/create Person — отдельная разрешённая команда. Fixture acceptance использует подтверждённую identity. Автосоздание контакта — отдельная настройка. Omni получает выделенный APP channel: прямой публичный ingestMessages в него запрещён, иначе upstream cache-lock path обойдёт links/receipts. Существующие обычные APP/email channels сохраняют контракт.

Outbound: conversationId,text,readyFileIds,idempotencyKey,expectedRevision → актуальные permissions/route/epoch → immutable pending Command + audit/event одним commit. Повтор ключа сравнивает также target/files, не только текст. После явного пользовательского решения повторить unknown создаётся новый commandId с replacesCommandId и предупреждением о возможном дубле.

| State | Переход | Запрет |
|---|---|---|
| pending | cancel/revoke до dispatch→cancelled; authorize+claim→dispatching | Нет send без текущих прав/epoch |
| dispatching | durable connector ACK→accepted; доказанный отказ до приёма→retry pending/failed; неоднозначный ответ→unknown | Нет нового commandId/provider resend по timeout |
| accepted | receipt/достоверное echo→sent; доказанный terminal reject→failed; неопределённость→unknown | Accepted не означает доставку |
| outcome_unknown | status/reconciliation→accepted/sent/failed либо остаётся unknown | Не угадывать failed и не слать повторно |
| sent | Подтверждённые delivered/read, ordered edit/delete | Старый timeout не откатывает sent |
| failed/cancelled | Новое явное намерение — новый ID | Старый lease не воскрешает send |

Recovery dispatching сначала status(commandId). Повтор разрешён только для идемпотентного connector enqueue того же ID при доказанном durable dedup. Единственный владелец provider retry — adapter/journal. Network call вне DB lock Twenty. Lease сам по себе не защищает provider от двойного вызова: fencing реализуется также в connector journal.

Echo-before-receipt создаёт один Message по native key и позже дополняет command link. Correlation только по доказанным native/transport IDs, не text/time эвристике. Без correlation — видимая reconciliation pending, не скрытие возможного дубля. UI pending bubble переходит в canonical Message по commandId, а не показывает обе подтверждённые записи.

## 5. Durable events и import/live

DomainEvent коммитится с mutation; ConsumerReceipt versioned consumerId + stable executionId. Сканер восстанавливает pending/running после Redis loss; claim не считается completed. Для внутренней CRM mutation эффект+completed один commit. AI/workflow admission резервирует stable run identity до enqueue; recovery ищет этот run прежде повторного запуска. EventEmitter не единственный журнал.

Trusted history_import context подавляет business CREATED/UPDATED listeners до dispatch, включая штатный database workflow trigger. Audit не подавляется. UI projection и automation dispatch — разные consumers; импорт может обновить разрешённый UI без запуска ИИ/рассылки. Caller не присваивает suppression сам, omni-channel bypass закрыт.

Activation boundary — provider/source position, а не receivedAt. Адаптер задаёт сравнение; неизвестный порядок разрешает хранение, но блокирует auto effect до reconciliation. Import-first/live-first/parallel создают один Message и один допустимый live admission после boundary. Новая activationVersion не переигрывает старую историю автоматически; явный reprocess имеет собственную команду/аудит. Own echo/internal note не получают admission входящего клиента. Causation/rootExecutionId и configured chain budget предотвращают loops; лимит даёт видимый paused/error.

## 6. Аудит — ROB-765/767

Writer appendEntry(executor,trustedContext,safeChange) использует workspace scope либо core QueryRunner, никогда отдельный repository. Success+mutation один commit. Поля: actor/initiatingActor, action, resource, outcome/reason, operation/correlationId, policyVersion, previous/new revision, timestamp, allowlisted diff. Токены, session data, полный текст чатов/prompts, credential URLs не пишутся. Bulk пишет реально изменённые строки; CREATED+UPSERTED не создают два success одной операции.

Before-image под row lock/CAS, общий lock order; concurrency не должна записать ложное previous. При unknown commit lookup operationId прежде повтора. Denial после rollback — отдельная ограниченная транзакция и alert при её отказе. Logout/revoke не блокируется отказом audit; потеря аудита не маскируется как успешная запись.

Порции: A own mutations; B REST/GraphQL/direct ORM CRUD/merge/bulk; C metadata/roles в migration QueryRunner; D sessions; E agent/workflow definition/publish/run/tool; F files/import/connector lifecycle. Raw/bypass registry: caller,purpose,tenant,writer,test; неизвестный интерактивный bypass denied.

Append-only: app DB role SELECT/INSERT audit, без UPDATE/DELETE/TRUNCATE/ownership и наследования migrator. Отдельная migration owner role, preflight effective privileges. Retention роль отдельно после выбора срока; без решения очистка выключена, размер мониторится. Защита от root/superuser не обещается.

Query/UI/export применяют текущий ACL/field visibility до count/page. Deleted resource — сохранённый descriptor плюс текущая admin policy. Cursor(createdAt,id), bounded page, actor/action/outcome/resource/correlation filters. Export проверяет policy epoch на каждой странице и выдаче файла; export audit один, без рекурсии на каждую прочитанную audit row.

## 7. Права и сделки — ROB-766

Own core WorkspacePolicyState(epoch), Team/TeamMember, ResourceAssignment/Grant, StageRule. Workspace-scoped keys/FK; objectMetadata/fieldMetadata IDs, не имена custom объектов. Catalog защищённых объектов: Person/Company/Opportunity/omni, производные TimelineActivity/Note/Task/targets/Attachment по §15.6 и явно выбранные custom objects. Включение custom объекта требует покрытия его entry points.

Decision = existing object/field grants AND own row/action grants. Own deny сильнее allow; нет разрешения protected resource→deny. Assignment/share/team ограничены resource/actions; Person→Opportunity relation не расширяет доступ. Admin — явная роль workspace, не blanket bypass. Bootstrap grant создаётся отдельной audited операцией, self-grant через обычный API запрещён.

Predicate до select/filter/order/count/groupBy/pagination, root и joined aliases. Запрещённые поля не участвуют в поискe/сортировке; relation mask/NULL не раскрывает hidden label. Writes проверяют before eligibility и allowed after; stable locks/CAS. Bulk target = разрешённый набор без раскрытия скрытых IDs; адресный hidden target даёт единый denied/not-found контракт. Scope сохраняется и при nested/merge/direct ORM.

Stage validator общий для transitionOpportunity и generic API/tool/workflow/import пути. From/to по fieldMetadataId и SELECT optionValue, отдельные read/edit/transition/configure actions. Исторический import — узкий purpose, не allow-all. Hidden stages не дают labels/counts через другие views. Удаление stage требует миграции правил, unknown stage не разрешает переход.

Revoke transaction: lock policy row→изменить grant/assignment→epoch++→audit→durable invalidation. Будущие reads/mutations проверяют актуальный authoritative epoch; event-only cache invalidation недостаточна. SSE проверяет перед следующей выдачей, export — каждой страницей/скачиванием. Уже отправленные байты нельзя отозвать; UI очищает недоступное, но backend не зависит от UI.

Protected files: parent Message/Conversation/record ACL в FileByIdGuard и всех альтернативных FileController/presigned paths; browser authenticated proxy вместо долговременного capability URL. Revoke блокирует новый запрос, уже отданные байты не возвращает. Public assets отдельная классификация. Transport grant command/file/TTL/size, недоступен browser/AI.

Rollout: own policy не активируется до покрытия всех entry points и fixture matrix. Workspace activation с bootstrap grants одним административным шагом. Ошибка enabled policy→fail closed, не возврат к широким grants. SystemAuthContext без собственного purpose не bypass. Новые omni endpoints до этапа 3 недоступны реальным пользователям; DB tests этапа 1 изолированы.

## 8. Коннекторы и UI — ROB-768

Перед переносом C/H/M файлов из research-connectors повторно сверить SHA, license/notices и diff. Только транспортные модули и тесты, не live .env/session/cache. Разделить route registry, durable journal, provider adapters и destination Twenty. Контрактный test делает любой SaleBot HTTP вызов ошибкой: Twenty receive/send/history обязан пройти без него.

Registry — authoritative owner platform/account/chat route + generation. Enqueue проверяет credential scope/owner/generation и durable unique commandId+payload, возвращает stable jobId; status не зависит от UI Twenty. Capability matrix реальных ревизий: native idempotency, status lookup, echo correlation, text/media/reply/edit/delete/read/history/ordering. Неизвестное не равно supported. MAX без доказанной idempotency не повторяет неоднозначный RPC; Telegram проверяется на фактическое использование stable transport ID.

Handshake protocolVersion/capabilitiesVersion; несовместимость запрещает activation, без fallback в SaleBot. Revoked generation запрещает новые enqueue/send, но поздние квитанции по уже созданным commandId принимаются отдельным authenticated reconciliation path. Старый ключ не получает право на новый send ради приёма receipt.

UI порции: ConversationList с server search/filter/cursor; Timeline с sequence и command correlation; Composer с text/files/reply и одним idempotencyKey на намерение до разрешения результата; CustomerPanel со штатными разрешёнными record links; Participants/Assignment; ConnectionStatus; InternalNote отдельный режим/endpoint; AuditPanel; AI mode/takeover. Lingui/Russian, штатные Twenty components. Transport credentials не попадают в браузер.

Каждый менеджер имеет свой вход; CRM хранит автора ответа, клиент видит подключённый аккаунт. Два осознанных ответа — разные команды. expectedRevision защищает изменение назначения/режима от перетирания, а не обещает запрет параллельных сообщений людей. Presence/typing не источник авторизации. Unread — lastReadSequence по сотруднику; own sends/internal notes имеют явно тестируемую политику счётчика.

SSE cursor связан с workspace/principal/policyEpoch/scope; sequence монотонен внутри conversation. Gap/retention expired→snapshot-required и перечитывание разрешённого snapshot. EventId dedup на клиенте; reconnect не повторяет sends из локального state. Revoke убирает ленту/preview/cache без полагания на это как на server guard.

Onboarding v1: binding/status/capabilities/reconnect-required; session secrets только в userbot. Встроенный QR/login либо внешняя панель — gate перед auth UI. До выбора можно реализовать transport contract/fake adapter, но нельзя объявить onboarding готовым.

## 9. ИИ/workflow — ROB-769

Переиспользуются AgentRun/turn/history/provider integration. TrustedExecutionReference серверный: workspace/conversation/initiating principal/application/agent version/controlEpoch/policyEpoch/rootEventId/activationVersion. Queue хранит reference ID, не редактируемый role/admin JSON. Каждый turn/tool восстанавливает reference и актуальное пересечение agent/application/caller/own policy. Потеря context не даёт Admin fallback.

human не запускает AI; assist создаёт draft; auto вызывает разрешённые инструменты и send. Auto activation требует provider/budget/role/policy и audit. Prompt/client attachment не меняют настройки. Knowledge sources явные, retrieval ACL до prompt; нет новой платформы LLM или робота. Limits бюджета/chain/timeouts дают видимую ошибку/эскалацию, не ложный успешный ответ.

Takeover/revoke lock order: WorkspacePolicyState→Conversation→CRM targets sorted. epoch++/mode/cancel pending AI commands/audit одним commit. Mutation tool берёт те же locks, проверяет epoch перед записью, audit в том же commit. Network/LLM вне lock. Send boundary — зарегистрированное начало dispatch; после неё исход может быть unknown, отмена уже принятой передачи не обещается. Stream cancel лишь оптимизация, не mutation fence.

Tools: scoped CRM read/search/CRUD/transition; knowledge read; internal note; workflow start; CommandService send; escalation. Максимальные прикладные права ограничены разрешённой CRM областью; credentials/инфраструктура не выдаются по умолчанию. Generic record CRUD и child workflow не должны терять scope.

Stable workflow executionId+actionId определяют idempotency key команды; identity фиксируется до Redis enqueue. Recovery ищет существующий run, а не создаёт второй. Типизированный OMNICHANNEL_EVENT trigger получает safe projection из DomainEvent consumer (§15.10), не WorkspaceEventBatch; import/own echo не запускают бизнес-цепь. Conversation context проверяется до application-role fallback. Обычные unrelated workflows сохраняют контракт, но защищённые объекты подчиняются own ACL.

Publish agent/workflow policy version атомарно с audit. Run закрепляет версию, текущая запрещающая policy может остановить его; нельзя молча смешать старые и новые permissions. UI показывает draft author/run/error/mode/takeover outcome. После LLM timeout admission и CommandService исключают второе намерение отправить тот же результат.

## 10. Файлы, edit/delete, история — ROB-770

Download через adapter: size limit до и во время stream, mime/extension policy, hash, filename normalization. Внешние URL: private/loopback/link-local/metadata deny, DNS/redirect проверки каждого hop. Internal authenticated storage — отдельный purpose. Quarantine/AV policy до выдачи; rejected media не теряет текст. Сеть не держит DB lock. Durable upload identity: metadata pending→object upload→DB finalize; crash восстанавливает по identity/hash, orphan cleanup отдельным journaled job.

Edit/delete сравнивает provider revision/source order; late create/edit не воскрешает tombstone. Несравнимый порядок→reconciliation, не incoming timestamp. Удалённый текст исключается из search/retrieval/AI context; audit хранит safe descriptor, а не полный текст. Tombstone не обещает удаление всех backup; физическое удаление/retention отдельная согласованная политика.

Import: source adapter SaleBot export/connector archive/native history, snapshot/range/accounts/version/capability check. Bounded page→durable receipts→checkpoint. Crash повторяет те же keys; batch ограничен bytes/messages, pause прекращает новые страницы. Source snapshot/generation/activation закреплены; смена источника — новый batch, не продолжение старого cursor.

Report: discovered/accepted/applied/duplicate/quarantined/missing-media, provider date range, gaps reasons, unbound identities. Completed — доступный выбранный диапазон, не обещание всей истории аккаунта. Import→live/live→import/parallel проверяются с включёнными AI и штатными workflow. Imported outgoing history не создаёт отправляемый Command.

## 11. Постоянные тесты

Ниже проектируемые имена; директории следуют existing Jest/Playwright conventions. Expected из контракта, не из проверяемой реализации. Тесты ещё не созданы/не запускались.

| ID | Suite / задача | Оракул |
|---|---|---|
| T01 | ingress-idempotency.integration / 764 | 20 concurrent same events→1 receipt/message/link; changed hash=409, original неизменён |
| T02 | ingestion-atomicity.integration / 764 | Fault перед каждым write/commit: нет partial Message/targets/link/audit/applied; replay безопасен |
| T03 | claim-fencing.integration / 764 | После reclaim второй worker завершает; старый token не меняет результат |
| T04 | command-recovery.integration / 764/768 | Lost ACK/Redis/crash→тот же job/command; provider unknown не увеличивает provider calls |
| T05 | messaging-email-regression / 764 | Старый email/postcommit matching работает; обычный APP works; omni bypass denied |
| T06 | audit-atomicity.integration / 765 | Нет success после rollback; точный concurrent before/after; app role не UPDATE/DELETE/TRUNCATE audit |
| T07 | audit-redaction-query / 765/767 | Secret canaries не в audit/log/export; чужие IDs/counts отсутствуют; revoke блокирует download |
| T08 | access-entrypoints.integration / 766 | A/B/lead/admin/AI/app, 2 workspaces, CRUD/relations/search/order/filter/count/groupBy/export/SSE/files/tools соблюдают matrix |
| T09 | stage-transition.integration / 766 | Одинаковый validator domain/generic/tool/workflow; hidden stage не раскрывает labels/count |
| T10 | revoke-barrier.integration / 766/769 | Порядок revoke vs read/mutation соответствует commit order; cache не оставляет старый allow |
| T11 | connector-contract / 768 | Оба канала dedup/status/generation; late receipt принят; SaleBot calls=0 |
| T12 | inbox-collaboration.e2e / 768 | Два разрешённых сотрудника видят историю, третий нет; repeat click/reconnect не дублируют send; note не уходит |
| T13 | ai-scope-takeover.integration / 769 | Generic tool/child workflow сохраняют scope; takeover до mutation блокирует, после не маскирует commit |
| T14 | automation-admission.integration / 769 | 2 workers/restart/Redis loss→один run/action effect; import/echo не запускают chain |
| T15 | attachment-security.integration / 770 | SSRF/private redirect/oversize/revoked parent denied; crash finalize восстанавливается, текст сохранён |
| T16 | import-overlap.integration / 770/769 | Все порядки до/после boundary: 1 Message, 0 historical и 1 разрешённый live effect |
| T17 | message-revision.integration / 770 | Delete-before-create/late edit/unknown order не воскрешают текст/AI context |
| T18 | migration-restore.integration / 771 | Fixture upgrade/restore DB+files+journals; старый outbox fenced до reconciliation |
| T19 | capacity-recovery / 771 | Утверждённая нагрузка; backlog/latency/unknown/audit alerts, нет бесконечного retry |
| T20 | free-self-hosted-acceptance / 771 | Без Enterprise key, оба тестовых канала без SaleBot, без реальных клиентов |

T02/T06/T08/T13/T16 имеют отрицательный контроль: отключение writer/guard/fence/suppression обязано уронить тест. Mock не доказывает PostgreSQL concurrency. Команды из CLAUDE/project.json: shared build, single Jest file, прямой package tsgo, integration Jest config на явно изолированной БД, UI component/e2e. Полный with-db-reset target не получает production env.

## 12. Эксплуатация и переход — ROB-771

Пакет: full Git/image SHA, migrator/schema/worker version, config/secret references, сверка running image/mounts. Build CPU/RAM/maxWorkers по измерениям, PSI/OOM monitoring и stop ненужного builder после работы; глобально алармы не подавляются. Один application stack, тестовые ресурсы явно отделены.

Метрики без переписки: receipt lag/retries/quarantine, command pending/unknown age, connector heartbeat/generation, consumer lag, AI failures/cost, policy denies/revokes, audit failures, storage/queue capacity. Correlation event→command→job→provider receipt. SLA/thresholds по выбранной нагрузке, до неё только технические ошибки/configured limits.

Restore rehearsal: согласованный комплект PostgreSQL/storage/connector journals/secrets, checksums и reference времени. Startup fenced без sends; сверка command/native IDs с journal/provider, unresolved unknown видимы; только затем восстановить owner/dispatch. Старая DB не отменяет уже отправленное, outbox нельзя просто replay.

Cutover route: inventory реально используемых функций SaleBot→acceptance→freeze новых старых исходящих→drain/reconcile unknown→capture boundary/checkpoint→generation/owner switch в connector registry→новый credential→replay inbound→доказать одного sender→наблюдение согласованного окна. Connector authoritative owner; Twenty binding disabled до подтверждённого handshake новой generation. Distributed atomicity между CRM/connector не предполагается. Старые receipts идут reconciliation path, старые sends rejected.

Rollback: freeze Twenty sends→drain/reconcile→сохранить journals/checkpoints→switch generation единственного owner→совместимый package/данные после анализа. Не запускать двух sender и не переотправлять pending из старой копии. Полное отключение SaleBot только после утверждённого inventory функций общения и отдельного разрешения конкретного окна.

## 13. Gates, которые нельзя выдумать

| Решение | Когда необходимо | До решения |
|---|---|---|
| Реальные роли/команды/stage visibility | Реальные сотрудники/T20 | Synthetic explicit grants; не allow-all |
| Telegram/MAX accounts/тестовые адресаты | Внешние sends | Fake adapters; не писать клиентам |
| QR/login в Twenty или внешняя панель | Onboarding UI | Binding/status contract, без заявления готовности auth UI |
| AI provider/model/budget/knowledge/auto rules | Auto activation маршрута | Stub и synthetic context; не самовключение auto |
| Import source/range/retention/delete policy | Реальный импорт/очистка | Synthetic history; без automatic deletion |
| Нагрузка/функции SaleBot | Capacity/cutover | Не обещать SLA или полное покрытие без inventory |
| Backup schedule/restore objective/window | Живой переход | Runbook/rehearsal, без live cutover |

Если продуктовый ответ требует иной архитектуры, соответствующий ADR обновляется до patch. Gates не заменяются умолчаниями ревьюера. Полнота сценариев Telegram/MAX/AI не урезается до drafts-only/Telegram-only.

## 14. Последовательность и журнал

ROB-764→765→766→(767+768)→(769+770)→771. «+» не разрешает одновременную правку общего файла. Reviewable порции: контракт/миграция→узкая server operation+test→adapter/UI→integration. Новая функция не готова только из-за зелёной сборки.

DEVLOG: контракт, changed files, команды/фактические результаты, commit и ограничения. Linear: статусы/зависимости/ссылки. План и его review не закрывают implementation issues. Финальный independent pass проверяет весь объект и contract, затем отдельно reconciles предыдущие findings; не только перечень старых замечаний.

## 15. Дополнительные обязательные контракты по исходникам

### 15.1 Таймлайн и защита канонической истории

ROB-766 включает `engine/core-modules/messaging/services/{timeline-messaging,get-messages}.service.ts`, `timeline-messaging.resolver.ts`, `utils/{format-threads,get-effective-message-channel-visibility}.util.ts`. В текущем TimelineMessagingService есть bypass repositories и выдача lastMessageBody; видимость аккаунта не равна собственному доступу к диалогу. Для omni thread все list/search/fallback/legacy person/company/opportunity timeline routes, participants и counters получают conversation ACL до query; владение connectedAccount не bypass. Нельзя просто скрыть body после выдачи subject/count.

ROB-764 защищает lifecycle уже при добавлении omni binding: generic update/delete/merge Message/Thread/Participant/associations для принадлежащих ему строк запрещены вне типизированной доменной команды. ROB-766 добавляет чтение через все эти пути. Раннее запрещение mutations не ждёт готового UI.

`BlocklistItemDeleteMessagesJob`, `MessagingMessageCleanerService`, jobs/listeners удаления channel/connectedAccount, reset-channel/remove-orphans и delete-folder/group-email services не удаляют omni canonical records. Политика владения читается из core binding/tombstone, а не только существующей строки удаляемого канала. Обычное отключение/удаление аккаунта с omni history отклоняется или преобразуется в domain disable до разрушительного lifecycle; cleanup jobs повторно проверяют persisted marker. Controlled purge — отдельная операция с permission, manifest Message/links/files/revisions, audit и retention; по умолчанию запрещена. Re-enable на том же provider account сохраняет bindingId/history, меняет session/generation; другой реальный account не подменяет старую binding.

Tests T21: менеджер с Person/connectedAccount, но без conversation grant, вызывает timeline/search/fallback/legacy endpoints — нет body/subject/participants/count. T22: blocklist/channel/account removal/reset/orphan cleanup/generic delete — история/links/files сохраняются либо явный отказ; обычный email fixture сохраняет старую cleanup семантику. ROB-764/766 не готовы без этих тестов.

### 15.2 Идентичность источника, контакта и внешнего автора

Различаем `sourceEventKey` (idempotency доставки) и `nativeMessageKey` (одно логическое сообщение). MAX bridge journal имеет UNIQUE(account,chat,messageId,direction,content_empty), что подтверждено source schema: это варианты source events, а не автоматически два разных bubbles. Adapter contract v1 включает raw ID, direction, source variant и canonical key version. Сравнение placeholder→populated сохраняет оба receipts и одну canonical Message, если adapter доказал одну identity; противоположные направления/неоднозначные variants не склеиваются. Mapping tests на реально выбранной версии предшествуют включению adapter. MessageLink UNIQUE использует versioned canonical nativeMessageKey; raw ID сохраняется для диагностики. Если native order/identity не доказаны, quarantined/reconciliation, не silent drop.

SaleBot.history возвращает identity_verified=false/direction_verified=false/replay_ready=false в исследованном коде. Поэтому SaleBot record ID не считается native Telegram/MAX ID. Source adapter либо предоставляет проверенную mapping, либо сохраняет history в namespaced legacy key и отключает автоматическую cross-source dedup; UI показывает legacy/unverified provenance, отчёт содержит возможные дубли. Даже неперекрывающиеся даты не доказывают идентичность; точное объединение только после mapping. Auto effects из legacy import запрещены. Чистая native/connector history имеет свой проверенный native key и полноценные overlap tests.

Person merge/soft-delete/restore через CommonMergeMany и direct writers получает lifecycle adapter: в том же executor перевести ExternalIdentity на разрешённый survivor или явно unbind, audit, policy epoch и AI-context invalidation. Cross-workspace merge denied. Person deletion не удаляет историю; новая случайная Person не подставляется. T23: обе identities после merge корректны, rollback сохраняет обе, delete/restore не раскрывают чужое.

Внешнее исходящее без Command (телефон/другой разрешённый transport source) сохраняется как canonical outgoing с actor external_sender/unknown provenance. Оно не запускает incoming automation и не связывается с AI command по тексту/времени. Auto mode требует выбранной externalHumanReplyPolicy: pause+epoch либо keep с явным принятым правилом; до выбора auto activation denied. Это product gate, а не молчаливое решение за пользователя. T24: external echo/no command, echo-before-ACK, concurrent AI send, обе выбранные политики.

### 15.3 Autonomous principal, устойчивые эффекты и отмена

Auto run имеет scoped service principal `(workspace,binding,conversation,automationPolicyVersion)`, без вымышленного user caller. Разрешённое чтение — пересечение application/agent grants и явно разрешённого ResourceScope диалога: verified Person и только явно связанные разрешённые Company/Opportunity/Task/knowledge. Связь Person с компанией сама по себе не открывает все её данные. Assist дополнительно пересекает права конкретного менеджера. Workflow без originating human имеет explicit service policy, с human — пересечение, child context не расширяется. Generic read/search/groupBy/execute_tool/export подчиняются тому же ResourceScope; scope применяется и к чтению, не только mutation. Unbound identity допускает только conversation и разрешённые общие knowledge entries, не workspace-wide CRM.

Knowledge v1: реестр источников с resource identity/version и explicit ACL, адаптер чтения разрешённых Twenty notes/documents/files; общие материалы явно отмечаются administrator policy. Skills/prompts не автоматически являются клиентской knowledge base. Retrieval result хранит provenance и policy epoch; revoked/deleted resource не попадает в новый prompt. Векторный index не вводится до необходимости; если добавляется, metadata ACL и stale-index deletion отдельные tests.

Добавляются core `OmniAutomationTurn` и `OmniEffectLedger`: turnId, admission IDs, captured input sequence, policy/epoch, state; effect key UNIQUE(workspaceId,turnId,effectKind,slot), immutable payloadHash, commandId/result, status. Turn и effect slot резервируются долговечно до выполнения. AI send key = turn/admission effect slot, не provider-generated toolCallId. Crash после Command commit до turn completion: recovery находит ledger/result и возвращает тот же Command; повторно сгенерированный другой текст для занятого slot даёт conflict/reconciliation, не новый send. Те же эффекты защищают generic create/update/delete/workflow start, а не только send. Максимум slots определяется explicit policy, не бесконечно новым tool call ID.

Один active autonomous turn на conversation под unique constraint/lock. Новые входящие образуют pending input range; debounce window — настройка, не угаданная константа. До dispatch stale draft может supersede, но committed effects не стираются и не повторяются. После завершения активного turn новый запускается для ещё не consumed admission range. Idle/burst tests подтверждают bounded replies, отсутствие starvation и повторов; strict revision check не отменяет все ответы бесконечно.

После crash в dispatching recovery повторно проверяет текущие actor/policy/epoch перед любым новым enqueue. Status not-found не разрешает старому AI send пережить takeover. Connector `cancelCommand` атомарно с claim journal возвращает cancelled либо too_late; отмена очереди возможна до provider-call boundary, после — reconciliation, без ложного cancelled. Pending send cancellation сохраняется durable outbox; при unavailable connector виден cancelRequested=true/unknown, не обещание мгновенной отмены. Caller не может отменить чужую command. Если старый HTTP enqueue может ещё прийти после cancel, connector хранит cancel tombstone по commandId, чтобы поздний enqueue не воскресил его. Перед provider call journal сверяет актуальную tombstone/generation.

Canonical business trigger для omni — durable DomainEvent/admission. Штатные Message record triggers для omni данных не являются вторым бизнес-потоком: suppression с последующей единственной durable projection для разрешённого события. Workflow send требует explicit conversationId/route; Person с двумя каналами без выбранного маршрута даёт validation error, а не случайный канал.

T25: broad app-role auto X не читает Y; assist/tool/child не расширяют scope. T26: kill после effect commit до turn result, regenerated tool ID/payload — один эффект/Command. T27: burst/new message while generating + crash — bounded turns, никаких потерянных pending admissions. T28: dispatching crash→takeover→status not found; cancel vs late enqueue; no stale provider send до оговорённой external boundary.

### 15.4 Restore и договор хранения журналов

Binding хранит acknowledged source journal cursor/high-watermark и adapter journal epoch. Connector сохраняет ACKed events и terminal command/effect evidence как минимум на согласованное recovery window (backup age + обнаружение + восстановление + запас). Это gate реальных данных; default 30 дней не доказательство достаточности. Готовность проверяет earliest replay cursor/status retention. HTTP 410/gap блокирует auto/cutover, создаёт отчёт неполноты; не объявляет replay успешным.

После restore весь binding fenced: inbound restore replay разрешён, business admission/AI/workflow/send отключены. Сверить restored receipt watermark с connector journal, повторить ACKed lost range и canonical messages; сверить outgoing/effect ledger, native confirmations, generations/owner. Для восстановленного диапазона origin=restore_replay подавляет автоматические эффекты до отдельного reconciliation; потерянный admission не означает право повторить ответ. Неизвестные command receipts сохраняются orphan-receipt quarantine. Создать исходящий Message допустимо только при доказанном native account/chat/message, actor external/recovered unknown; нельзя выдумать менеджера или отправку по receipt без подтверждения.

Recovery auth отделяет текущую авторизацию journal replay от original event generation/hash. Старый immutable envelope сохраняется, transport request подписан текущим узким recovery credential. Обычный revoked sender не может использовать этот путь. Owner/route поколение берётся из connector registry, не откатывается blindly со старой DB. Снятие fence только после отчёта gaps/unknown/effects и выбранной activation boundary; replay не переигрывает уже совершённые provider effects.

T29 restore snapshot до receipt ACK/AI admission/Command, connector помнит отправку: восстановленная история полна в доступном диапазоне, повторных автоответов нет, старые/unknown receipts видимы, journal gap блокирует automation. Это расширяет T18, не ограничивается outgoing-only reconciliation.

### 15.5 Метаданные, права БД, ревизии и тестовая среда

Opportunity.stage сейчас string SELECT, не FK Stage. Wire contract — `targetStageValue` + `expectedStageOptionsHash`, StageRule key `(workspace,objectMetadataId,fieldMetadataId,optionValue)`; хэш канонического набора значений конкретного SELECT проверяется отдельно. Глобальный workspace.metadataVersion не входит в identity rules: постороннее изменение метаданных не инвалидирует разрешённые переходы. Label переименование не меняет optionValue; изменение/удаление optionValue отклоняется при активных rules до одной audited migration rules+metadata. Поддержка нескольких воронок — отдельный product gate; существующей сущностью не объявляется. T30: metadata rename/delete/stale client/generic update в одной policy модели.

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
| send_commands | UNIQUE(ownerInstance,commandId), payloadHash,target,generation,state,leaseToken,effectStarted,nativeId,result | queued→claimed→provider_started→confirmed/failed/unknown; timeout не failed |
| command_cancel | UNIQUE(ownerInstance,commandId), requestedAt,generation | cancel-before-enqueue сохраняется; проверка под тем же lock с claim/provider boundary |
| command_attempts / resolutions | commandId,token,version,outcome,evidenceRef | terminal evidence append, все manual resolutions audited |
| checkpoints | account/source, journalEpoch,cursor,earliestRetained | durable receipt before advance; gap explicit |

Central connector ACK означает durable command в его БД. Перед вызовом userbot он сверяет owner/generation/cancel, но это ещё не provider boundary. Та же idempotent command и cancel fence обязаны дойти в journal userbot: поздний сетевой enqueue после отмены не возрождает send. Только userbot, непосредственно вызывающий provider, вправе вернуть cancelled/too_late относительно provider-call. Неизвестность central↔userbot тоже unknown, reconciliation по тому же commandId. Смена owner fencing также проверяется userbot; центральный CAS без этого недостаточен. T11/T28 fault injection на обеих границах, per-chat order и process crash; SQL/SQLite транзакции реальны, не только mocks.

Echo: outgoing event сначала `correlation_pending`; отсутствие Command в Twenty не доказывает внешнего автора. Userbot journal связывает originCommandId по подтверждённому native send result/устойчивому provider ID, а коннектор публикует correlation update. При ещё незавершённой отправке в этот чат echo удерживается в durable journal либо доставляется pending без изменения mode/epoch. Только доказанное externalOrigin применяет externalHumanReplyPolicy. Если корреляция неразрешима, reconciliation с явной неопределённостью; не автоматический external_sender. T24: собственное AI echo-before-ACK не ставит auto на pause; доказанный external reply следует выбранной политике; crash не теряет удержанное echo. Author audit/MessageLink хранит actor immutable snapshot/member ID независимо от participant.workspaceMemberId: штатный email rematch может обнулить последнее.

Capture generation неизменно записывается при захвате события. При cutover неподтверждённый старый event не переподписывается новым semantic generation. Обычный ingress принимает только current generation. Узкий reconciliation endpoint проверяет актуальные recovery credentials, original hash и evidence исторического owner из connector registry; canonical receipt key не меняется. Это тот же контракт replay, что §15.4, применяется и к cutover, и к restore. T11/T18: pending old generation, repeated old/new transport signatures, ни потери события, ни hash conflict от переписывания generation.

Размещение connector/userbots/DB, владелец backup и network boundaries — gate до интеграционного deploy. План выбирает отдельный transport process и отдельное хранилище; физический host/managed DB/volumes не выдумываются. До выбора используются isolated integration fixtures. Работающий SaleBot connector не изменяется переносом исходников.

### 15.8 Lifecycle, DB privilege и запуск

Omni ConnectedAccount имеет `applicationId=NULL`, `connectionProviderId=NULL`; binding владеет отдельным APP channel. AccountBinding содержит FK на connectedAccount и messageChannel с `ON DELETE RESTRICT` (workspace consistency дополнительно проверяется); каскады Application/Provider/UserWorkspace/account не стирают канал молча. Lifecycle guard переводит disconnect в domain disable; DB constraints — последний барьер для raw cascade. T22: delete app/provider/account/member/workspace, bulk/direct paths; сохранение истории либо понятный отказ, email regression отдельно.

Удаление workspace с omni/audit данными по умолчанию denied с указанием controlled purge. Explicit authorized purge: fence route/userbots, reconcile sends, запрет новых writes, manifest core/workspace/files/journal references, policy retention и аудит операции в отдельном admin ledger без каскада вместе с workspace. Только после проверки manifest возможно удаление; irreversible purge имеет отдельное разрешение и не входит в обычный disconnect. Нет автоматической чистки orphan audit по удалённому workspace.

CrmAuditEntry и admin deletion ledger лежат в отдельной схеме `crm_audit` той же PostgreSQL; explicit schema metadata в entity. Owner — отдельная migrator/audit role, runtime не владеет этой схемой/таблицами/БД, не superuser/CREATEROLE, не наследует owner и не может SET ROLE owner. USAGE+SELECT/INSERT без CREATE/UPDATE/DELETE/TRUNCATE; protected sequence grants только необходимые. Runtime ownership core или создаваемых workspace schemas не даёт права DROP crm_audit. Preflight проверяет effective membership/database/schema/table ownership и отрицательные DROP/ALTER/TRUNCATE тесты. Runtime PG role separation и передача текущего владения — отдельная операция до включения append-only гарантии, не действие документа. Upstream provision/migrations проверяются с этим разделением, permissions не ослабляются молча.

Fork migration split по §15.5 дополнительно: static test запрещает fork decorators/imports/providers в upstream discovery, startup command/module imports runner только явно, autogenerated SQL snapshot сохраняется один раз вне version dirs. Turn/EffectLedger вводятся миграцией ROB-769, metadata-only Revision — ROB-764 (расширение payload в ROB-770), audit schema/writer — ROB-764, queue grants — ROB-766. Integration fixture init/reset использует тот же manifest. T33 проверяет actual command list и fail-fast любой upstream/fork error, не только happy-path DDL.

### 15.9 Порядок блокировок, инструментов и поиск

Один lock protocol для всех доменных операций: WorkspacePolicyState → AccountBinding/RouteActivation (sorted IDs) → Conversation (sorted IDs) → ExternalIdentity → изменяемые CRM records (stable object/id order) → Command/Receipt/Turn. Claims receipt/job делаются короткой отдельной транзакцией; apply transaction не держит lock claim из предыдущего порядка, повторно проверяет token. Merge предварительно собирает references, берёт locks по порядку и перечитывает graph; при изменении начинает заново. Ingress без CRM операции использует совместимый prefix. Outbound provider calls вне locks. Retry 40P01/40001 ограничен configured budget и повторяет ту же idempotent domain command; exhausted error visible, external send не входит в retry transaction. T02/T10/T23/T28 добавляют merge+ingest+takeover+disable interleaving и control test обратного lock order.

Omni auto исключает upstream pausing tools ask_question/request_form/propose_tool_call/wait_for_event из advertised AND executable set, в том числе dynamic execute_tool. В режиме assist их использование тоже не оставляет autonomous slot: запрос оператору оформляется собственным завершённым turn с handoff/task, возобновление — новый authorized turn. Это не запрещает обычные ответы и операции CRM. T27: попытка hidden/pausing tool отклонена, turn завершён/failed, следующие admissions обрабатываются, starvation отсутствует.

Серверный поиск v1 использует ограниченный запрос Message body/subject + conversation/MessageLink join с ACL до результатов/count и bounded cursor; у Message не предполагается готовый searchVector. При текущей неизвестной нагрузке обещаний latency нет; T19 определит необходимость собственного tenant/conversation scoped text index. Edit/delete немедленно меняет canonical query result; при будущем index вводятся atomic update/delete и stale-index tests. T12/T17 проверяют поиск, запрет раскрытия скрытых targets и удалённых текстов.


### 15.10 Исполнимые точки интеграции workflows и messaging helpers

Новый тип триггера `OMNICHANNEL_EVENT` в shared workflow trigger types, validator, server builder/core-version sync и front trigger selector/form. Виды событий v1: `message.received`, `conversation.created`, `assignment.changed`, `status.changed`. Настройка: binding/queue filter, вид события, разрешённые условия по safe projection; произвольный SQL и hidden field filtering не допускаются. Сохранение/publish проверяют права администратора и service execution policy; UI на русском показывает, какой event и route запустит процесс. Это обязательная часть ROB-769, не будущая optional интеграция.

`OmniWorkflowTriggerConsumer` читает committed DomainEvent, определяет eligible опубликованные версии по trusted admission/origin и policy. ConsumerReceipt key `(workspace,eventId,consumerId=workflowVersionId)`; stable workflowRunId = UUID namespace(workspace,eventId,workflowVersionId), без random ID при retry. До queue enqueue сохраняет execution reference, payload hash и run intent. `CoreWorkflowRunnerService.run` вызывается с этим workflowRunId; повтор/Redis loss сначала проверяет имеющийся run/intent, resume того же run. Настройка event→version фиксируется в durable routing intent до запуска, поздняя публикация новой версии не переигрывает прошлое событие. Отключение workflow до запуска запрещает start, не удаляет evidence; текущая permission policy проверяется повторно.

Payload projection: eventId/kind, conversationId/bindingId, messageLinkId при наличии, trusted initiating principal/reference, origin/admission, causation/rootExecutionId; body/CRM fields читаются только scoped tools при выполнении, не вложены в public event. Для `message.received` нужно admission клиентского live-входящего; own echo/note/import/restore_replay не допускаются. `conversation.created` от history import также не запускает workflow; assignment/status events требуют explicit domain operation, policy и chain budget. Typed consumer напрямую создаёт run intent; он не вызывает штатный WorkspaceEventBatch listener и не переводит своё событие обратно в wildcard emitter. T14: настройка в редакторе→два workers→Redis loss/restart дают один run и action effect; edit/publish/revoke между intent и start проверяются. Импорт/echo/note дают ноль omni runs и ноль штатных listener calls; обычный не-omni database trigger продолжает работать.

`withOmniRepositoryOptions(scope)` — trusted server adapter над тем же WorkspaceTransactionScope, без открытия новой транзакции: workspaceId/executeRawQuery/afterCommit делегируются, getRepository для allowlist message/messageThread/messageParticipant/messageChannelMessageAssociation и используемых target associations принудительно добавляет `{shouldSkipEventEmission:true}` третьим параметром. Helpers `saveMessagesWithinTransaction`, `saveMessageParticipants`, match/reconcile получают только этот wrapped scope для omni операции. Динамический metadata name нормализуется сервером; caller не управляет allowlist. Для остальных CRM records сохраняются переданные options. Raw writes должны создавать требуемый DomainEvent/audit сами и не emit generic событие. Запрещено вызывать aggregate, который открывает собственную транзакцию или запускает postcommit matcher для omni. Email caller передаёт исходный scope и сохраняет свой emission/matching behavior. T05/T14/T16 проверяют фактические emitted events всех helper writes, rollback и отрицательный контроль удаления wrapper, не только unit mock опции.

Канонические ключи в helper adapter: headerMessageId = `omni:v1:` + SHA-256(canonical length-delimited encoding(bindingId,providerChatId,nativeMessageKeyVersion,nativeMessageKey)); messageExternalId = versioned nativeMessageKey; messageThreadExternalId = providerChatId в контексте выделенного binding channel. Raw native IDs сохраняются отдельно. Prefix зарезервирован, обычный APP ingest не может использовать его как headerMessageId; email/provider paths не допускают слияния с omni headers без совпадения ownership link. Перед вызовом helper binding+conversation locks и UNIQUE MessageLink защищают duplicate create; при уже известном MessageLink использовать exact messageId, повторный global header lookup не является oracle идентичности. Обнаруженное старое чужое header совпадение → явный conflict/reconciliation, не reuse чужой записи.

Helper только создаёт первоначальную canonical Message. Placeholder→filled для одного native key, edit и delete идут через domain revision operation: сравнить trusted source variant/order, обновить точный messageId/body/attachments и current search data в общей транзакции, receipt/revision/audit; не полагаться на no-op существующего helper. Изменение placeholder не создаёт повторный admission/effect; automation получает eligible complete content только один раз по явно определённой adapter completeness, pending placeholder не запускает AI. OmniMessageRevision минимальная metadata-only схема и write service вводятся уже в ROB-764 (перенос из прежнего ROB-770); ROB-770 расширяет защищённый payload/files/retention. T01: одинаковые raw IDs в двух аккаунтах/чатах, попытка reserved header чужим каналом, concurrent replay; T17: placeholder→filled/late create/delete-before-fill дают один Message, верный текст/тombstone, два receipts и не более одного допустимого admission.

### 15.11 Отправка менеджера, владелец канала и исторический автор

`managerReplyPolicy` — обязательная настройка до auto activation: `takeover_on_send` или `require_explicit_takeover`. Первый вариант в той же транзакции sendCommand делает human mode/epoch++/cancel pending AI commands/audit, затем создаёт человеческую Command; второй отклоняет composer send до явного takeover, UI предлагает эту операцию. Независимые конкурирующие human+AI sends не предлагаются как default, поскольку противоречат F-04. До выбора auto denied. Перед provider boundary отмена и fencing по §15.7, после зарегистрированного начала внешней отправки возможен too_late/unknown — UI честно показывает уже начатый AI send. T13/T24: менеджер отправляет во время LLM generation, перед claim и после внешней границы; исход соответствует выбранной политике, нет stale новых AI sends. Ответ менеджера в assist/human не требует лишнего auto takeover.

Omni ConnectedAccount: scope='WORKSPACE', userWorkspaceId — действующий явно назначенный custodian workspace membership; это технический владелец upstream reference, не grant на все разговоры. При binding creation проверяются custodian и queue policy. AccountBinding.status authoritative для omni. Смена scope/archive/isSyncEnabled/userWorkspaceId через generic metadata UI/API либо guarded domain operation, либо denied; email accounts сохраняют upstream behavior.

Перед удалением custodian lifecycle service находит все omni accounts. В общей owner-transfer транзакции под policy/binding locks назначает разрешённого нового custodian без archivedAt/token-null/isSyncEnabled side effects, пишет audit и обновляет ссылки; затем разрешает удаление старого membership. Если нового custodian нет, удаление последнего владельца отклоняется с явным требованием переназначения/controlled workspace purge; висячий userWorkspaceId запрещён. `ConnectedAccountOwnershipTransferService` и metadata.transferOwnership исключают omni из штатного archive path, используя domain transfer; повторный guard проверяет итог при direct/bulk writes. Удаление обычного менеджера меняет grants/epoch, не выключает общий канал. T22/T31: удаление custodian с/без successor, rollback/race, generic archive и native role revoke; history/binding сохраняются, обычный email transfer regression проходит.

Импорт хранит sourceAuthorId/sourceDisplayName/sourceSystem и authorVerification в provenance сообщения/ревизии. Это исторический автор из источника, не автоматически действующий сотрудник CRM. Только explicit audited admin mapping связывает его с workspaceMember; без mapping UI показывает исходную подпись и unknown/external provenance. Такой автор не получает grants и не становится initiating principal новых effects. T16: unmapped/mapped/deleted manager, repeated import и conflicting mapping; ложной атрибуции нет.
