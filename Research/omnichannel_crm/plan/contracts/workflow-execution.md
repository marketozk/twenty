<a id="design-0"></a>

# Выполнение workflow и ИИ

<a id="design-1"></a>

Нормативный контракт. [Владельцы определений](README.md); схема/UNIQUE — [спецификация §3](../implementation-spec.md#3-схема--rob-764). Ссылки «§15.x» означают сохранённые разделы спецификации. Новый runtime ещё не реализован.

<a id="design-2"></a>

## 1. Поток и общие инварианты

<a id="design-3"></a>

DFD уровня компонентов для разработчика: показывает, где закрепляются права и разрешение на ответ. Существующие services Twenty переиспользуются за единой доменной границей.

<a id="design-4"></a>

```text
Client event -> Receipt -> canonical Message + Admission + DispatchPlan (one DB commit)
                                                        |
                                 immutable targets: agent / workflowId + pinned version
                                                        |
                           trusted execution reference + OmniToolPolicyRegistry
                           [scope + current grants + mode + epochs + capability]
                                                        |
                      common reply budget / effect ledger -> Command -> connector
```

<a id="design-5"></a>

Внешний текст, новый token, смена версии workflow и повтор queue job не создают новые права на данные или повторный ответ. План получателей фиксируется вместе с business admission; Redis только ускоряет исполнение. Человеческая ручная отправка сохраняет свою policy/mode/CAS, общий автоматический бюджет её не подменяет.

<a id="design-6"></a>

## 2. Закрытый каталог инструментов и передача полномочий

<a id="design-7"></a>

`OmniToolPolicyRegistry` — нормативный закрытый набор capabilities, отображённый на существующие реализации Twenty через wrappers. Запись содержит tool/capability ID, разрешённые режимы, допустимые objects/fields/relations, требования к resource scope, класс эффекта и способ аудита. Неизвестный инструмент запрещён. Одно правило применяется к direct discovery, learn_tools/get_tool_catalog, direct execute, resolveAndExecute, execute_tool, child execution и MCP ingress. Фильтр показа не заменяет enforcement; nested toolName проверяется после разрешения alias. Reference восстанавливается из серверного хранилища, не из пользовательского JSON.

<a id="design-8"></a>

| Capability v1 | Исполнение |
|---|---|
| scoped CRM read/search/aggregate | Только объекты/поля и records из captured ResourceScope ∩ current grants; counts и related labels также фильтруются |
| scoped CRM create/update/delete/stage transition | Общие domain services, текущие права, control/policy fences, effect ledger и audit; deletion не bypass lifecycle |
| read conversation / approved knowledge / protected files | Parent ACL и provenance, без выдачи широких storage credentials |
| send client message | Только OmnichannelCommandService + общий reply budget; произвольный route запрещён |
| start approved workflow / child agent | Зарегистрированный target и наследуемые reference/полный covered admission set/budget; descendant scope только сужается |
| handoff / create task / internal note | Завершённая доменная операция по правам, не удерживающий auto-turn pausing tool |

<a id="design-9"></a>

Raw `http_request`, `send_email`, `draft_email`, `find_connected_accounts`, `create_calendar_event`, `create_file_upload`, `complete_file_upload`, `code_interpreter`, `save_campaign`, `share_record`, logic-function execution и любые прочие upstream tools не становятся разрешёнными из role flag. Для omni v1 они не рекламируются и запрещены в executor, пока для них нет отдельной scoped capability записи с проверенным wrapper и тестами. Вспомогательные search_output/extract_json_paths/search_help_center тоже не исключение из closed registry. Это не запрет нужных бизнес-операций CRM: они доступны через перечисленные безопасные capabilities; расширение каталога является явным изменением политики/контракта, а не догадкой модели.

<a id="design-10"></a>

Omni v1 **не выпускает generic application access tokens**, не предоставляет sandbox credentials и не позволяет пользователю подставить application token как продолжение captured execution. CodeInterpreterTool/issuer запрещаются на пути omni до выпуска token. Новое HTTP/MCP обращение от исполнения разрешается только через серверный internal dispatcher с verified execution reference и той же policy, иначе deny; общий MCP для обычных пользователей Twenty сохраняет прежний auth, но не считается способом продолжения omni-run. Отдельный будущий bounded-token протокол потребует собственного решения и тестов; один TTL не достаточен.

<a id="design-11"></a>

Для auto omni исключаются все имена `keys(PAUSING_TOOLS) ∪ AGENT_WAIT_TOOL_NAMES`, включая legacy ask_questions и wait_for_duration, плюс background AgentRunner получает `pausingTools: []`. Статический inventory проверяет отдельные injection paths и новые имена; имя не обязано присутствовать в advertised catalog, чтобы быть запрещённым на исполнении. Assist оформляет запрос к менеджеру через завершение turn/handoff; slot не остаётся занят ожиданием.

<a id="design-12"></a>

### Все исполнители под одним reference

<a id="design-13"></a>

Политика распространяется на **любой run с omni execution reference**, включая обычный workflow, запущенный из omni агента, AI_AGENT внутри workflow и всех потомков. Вид триггера не является границей защиты. `OmniWorkflowActionPolicy` — закрытая таблица step type → scoped executor; неизвестный/new type запрещён. v1 допускает FIND_RECORDS/PICK_RECORD только через scoped reader, CREATE/UPDATE/DELETE/UPSERT_RECORD через scoped mutation + effect ledger, AI_AGENT через защищённый AgentRunner, FILTER/IF_ELSE/ITERATOR/EMPTY как чистые операции, FORM/DELAY/WAIT_FOR_EVENT через durable registration с current ACL/fences. Собственный send action идёт через CommandService/общую квоту. Остальные upstream actions (включая CODE, LOGIC_FUNCTION, HTTP_REQUEST, SEND_EMAIL, DRAFT_EMAIL, CREATE_CALENDAR_EVENT, CLASSIFY и внутренний SEND_CHAT_MESSAGE) не получают разрешение автоматически. CLASSIFY явно deny в omni v1: он вызывает AiEvaluationService; будущее разрешение обязано учитывать AI provenance/sender-mode и scoped context. Для нужного нового эффекта требуется отдельная scoped capability и контракт проверки.

<a id="design-14"></a>

Publish/activation **любой** версии с omni capability (включая SEND_OMNI_MESSAGE, scoped omni tool или child target) независимо от trigger type и регистрация approved child target проверяют весь pinned flow по этой таблице до первого шага. Persisted omni-governed marker и server classification не снимаются пользовательским input. При каждом start/step/resume executor повторно проверяет серверный reference + current policy до вызова action factory, token issuer или network. Child обычного workflow проверяется при запуске и каждом шаге так же, даже если он был опубликован раньше для не-omni работы. Direct/manual не-omni workflow сохраняет обычное поведение; пользователь не может снять reference у continuation. Нельзя разрешить действие по одному типу триггера или довериться validation UI.

<a id="design-15"></a>

AgentToolset добавляет tools вне registry. Поэтому под omni reference принудительно `nativeToolOptions = {}`, `canAskHumans = false`, `waitTools = {}`; AgentRunner получает пустой pausing set. После объединения direct/native/pausing/extra/meta выполняется проверка итогового набора по registry (meta разрешены только с защищённым nested dispatcher). Activation агента с webSearch/twitterSearch или workflow AI-шагом с humanInputInstructions отклоняется явно. Background, foreground и AI_AGENT workflow paths одинаковы. Provider-executed native tools в v1 не предлагаются: их нельзя ограничить серверным executor после передачи провайдеру. Изменение agent config после activation ловит проверка перед turn, не silent allow.

<a id="design-16"></a>

Запрет pausing относится к агенту, включая агент внутри workflow. FORM/DELAY/WAIT_FOR_EVENT — отдельные шаги workflow с durable wait registration и текущими правами; они не удерживают активный autonomous agent turn. Продолжение после ожидания наследует тот же reference/covered admission set и проверяет epochs заново.

<a id="design-17"></a>

## 3. Стабильная раздача событий

<a id="design-18"></a>

`EventDispatchPlan` имеет UNIQUE(workspaceId,eventId), captured policy/activation version, immutable targets и state (включая явный empty/suppressed). Каждый workflow target содержит stable workflowId и pinned workflowVersionId; **consumerId = omni-workflow:{workflowId}**, UNIQUE(workspaceId,eventId,consumerId), runId определяется только [единым правилом](#run-identity). Версия — payload, никогда часть idempotency key. Agent target использует стабильный automation policy ID, а не model/tool-call ID. Payload hash исключает повтор с подменой содержания.

<a id="design-19"></a>

При первом business admission план, все target receipts/run intents и общий reply budget фиксируются атомарно вместе с admission. Публикация/деактивация подписок сериализуются с этой транзакцией через существующий WorkspacePolicyState fence: admission SHARE, lifecycle UPDATE до изменения каталога; порядок locks соответствует §15.9. Ни один worker не выбирает список текущих подписок заново при replay. Пустой план тоже сохраняется: поздняя публикация не делает старое событие новым. Для событий до установки автоматизации activation boundary не позволяет задним числом создать effects. Размер набора ограничен конфигурацией и квалифицируется до activation; ошибка планирования не выдаётся за завершённую обработку.

<a id="design-20"></a>

Publish v2 после сохранения target v1 не создаёт второй target и не меняет pinned v1. Деактивация до начала target переводит его в cancelled/denied с audit; reactivation не оживляет его автоматически. Уже принятый run использует сохранённый flow с текущими access/mode fences; запрещённый эффект не выполняется. Explicit replay требует отдельной пользовательской операции и replayRequestId с предупреждением о committed/uncertain effects; это не автоматический retry E под новой версией.

<a id="design-21"></a>

RunIntent хранит runCreatedAt/created evidence, runId, pinned version, terminal disposition и refs на effect ledger независимо от строки native workflowRun. Raw cleaner Twenty может удалять отображаемый COMPLETED/FAILED run только при сохранённом canonical evidence; удаление не сбрасывает admission/receipt/tombstone. Отсутствие native строки само по себе никогда не разрешает повторный create/run. Recovery сначала читает intent; ambiguous creation reconciles по стабильному ID/creation evidence, unresolved → visible stalled, не повтор эффекта. Retention intents/tombstones не короче допустимого replay/recovery window; событие старше доступного evidence закрывается gap/quarantine. Read paths этих данных сохраняют собственный ACL. Run identity — [единое правило](#run-identity).

<a id="design-22"></a>

Штатный `retryWorkflowRun` для любого run с omni intent/reference отклоняется **до** изменения native status/state или enqueue, независимо от наличия terminal disposition. UI убирает обычный Retry и показывает отдельную операцию replayRequest; API всё равно проверяет серверную связь с intent. Все terminal FAILED/COMPLETED/CANCELLED transitions omni run атомарно записывают native status и intent disposition через общий finalizer (включая catch/error/status-computation paths). Неполный legacy outcome → visible reconciliation/stalled без нового запуска. Обычный не-omni Retry не изменяется. Явный replay не сбрасывает прежний effect/budget ledger.

<a id="design-23"></a>

### Обычные триггеры, которые ведут к omni-эффекту

<a id="design-24"></a>

`OmniRootExecution(workspaceId,rootKind,rootId,sourceKey,origin,causation,scope,policyVersion,state)` — общий durable корень. Message admission — один его вид. Любой workflow с omni capability является omni-governed целиком: DATABASE_EVENT/CRON/WEBHOOK/MANUAL также входят; до AI/любого шага нужен trusted reference. Исполнение без reference не получает omni tools, а SEND_OMNI_MESSAGE отказывает независимо от роли. Проверка делается на publish всей версии и на любом start/resume; вызов такого child из обычного workflow проходит ту же границу. Нельзя сначала выполнить широкий AI-шаг и только перед отправкой оформить reference.

<a id="design-25"></a>

До activation G07 задаёт service principal и явное ограниченное правило выбора conversation из trusted trigger record/заданного маршрута; G17 — только дополнительное разрешение шаблонов в human/assist, а не обход governance. Scope корня = выбранный conversation и явно разрешённые связанные trigger records ∩ current grants; не workspace-role целиком. Missing/ambiguous/hidden target → отказ до первого шага. Несколько маршрутов не выбираются автоматически: v1 один явно разрешённый target на запуск; массовая рассылка отдельным этим контрактом не включается. Смена режима/прав проверяется также перед эффектом. AI-контент не становится G17-шаблоном через метку пользователя.

<a id="design-26"></a>

| Вход | Trusted source key / durable admission до enqueue |
|---|---|
| Message | существующий AutomationAdmission ID; все consumers делят один root |
| conversation.created | При live eligible сообщении наследует root/covered set того же message admission; не отдельная квота. Import/restore/incomplete origin — empty/suppressed, не business send |
| assignment.changed / status.changed | Governed mutation наследует весь causation/covered set; независимая authorized mutation: rootKind=domain_event, sourceKey=DomainEvent.eventId, один stable root и общая квота |
| DATABASE_EVENT | durable event ID от mutation transaction; версия записи/объекта входит в provenance. Для подписки omni-governed запись DomainEvent+target intent создаётся с CRM mutation, native listener исключает этот target из отдельного enqueue |
| CRON | stable schedule ID + planned UTC occurrence, не время retry; receipt/target intent фиксируются до enqueue |
| WEBHOOK | authenticated binding + обязательный caller idempotency key + canonical payload hash; тот же key с иным payload conflict; нет key — отказ |
| MANUAL | actor + обязательный command idempotency key + canonical payload hash; retry UI переиспользует key, новый осознанный запуск — новый command |

<a id="design-27"></a>

Для независимого non-message входа rootId = UUIDv5(workspaceId,rootKind,sourceKey); receipt UNIQUE(workspaceId,rootKind,sourceKey), target run identity — по [единому правилу](#run-identity). В одной DB transaction сохраняются root, scope/policy, immutable target snapshot, receipts/intents и общая квота. Replay/publish не создаёт новый root. Native trigger adapters для governed targets идут через этот ingress; обычные targets сохраняют свой путь. Для пропущенного durable evidence — видимый gap/stop, не реконструкция по текущему состоянию. Retention/restore/import suppression из §15.4 распространяются и на эти roots.

<a id="design-28"></a>

Изменения CRM из governed run сохраняют causation и полный inherited root set в trusted transaction context и durable event. Subsequent triggers и дети наследуют его и оставшиеся effect/reply budgets, не объявляют изменение новой независимой причиной. Для (root,workflowId) повторный target не создаётся (UNIQUE в intent target index); при covered set из нескольких roots все target claims резервируются атомарно, runId определяется [единым правилом](#run-identity). Частичный/пересекающийся уже занятый набор отклоняется с видимым handoff, не создаёт ещё один run для части roots; если нужен тот же workflow повторно, это отдельный explicit replay после разбора. Missing/lost causation на внутреннем событии → отказ/quarantine, а не свежий root. Общий конечный max CRM effects/hops и per-route admission/rate budget задаются в G07 до activation; исчерпание → один durable handoff без следующей мутации/рассылки. Это останавливает цикл update→trigger→update. Новые независимые внешние события получают свои roots только после аутентификации и rate admission; клиентский payload не задаёт ancestry. Burst хранит набор (rootKind,rootId); descendants наследуют весь набор без расширения или обнуления.

<a id="root-effect-budget"></a>

Общий effect/hop budget физически хранится на OmniRootExecution: immutable maxCrmEffects/maxHops из captured policy version и usedCrmEffects/usedHops. OmniRootBudgetCharge — immutable proof одного расхода по root/chargeKind/stableChargeKey. Эти root budget rows блокируются по всему covered set в позиции DispatchPlan/ReplyBudget общего lock protocol (после изменяемых CRM records и перед Command; полный порядок только в access-control#lock-protocol), в стабильном root порядке. Частичного commit по набору нет.

CRM charge использует stable effect ledger identity, не новый случайный toolCallId на retry. Стоимость — фактически изменённые distinct business `(resource,action)` пары одной domain mutation; audit/outbox/counter bookkeeping не считается эффектом. Bulk также расходует все actual business rows, а не один вызов; no-op стоит0. Проверка остатка, mutation, effect result, charges/счётчики и audit проходят одним transaction/executor; недостаток квоты откатывает всю business mutation. После rollback terminal budget_exhausted и один durable handoff сохраняются по прежнему idempotent terminal protocol, без повторного эффекта. Повтор committed effect возвращает результат и не расходует квоту заново; unknown commit сначала сверяется по durable effect/charge evidence.

Hop — новый дочерний governed execution/intent (включая descendants DATABASE_EVENT), а не retry/resume шага. Первичные agent/workflow targets всех immutable initial EventDispatchPlan нового trusted root стоят0 hops: сюда входят message.received и conversation.created одного admission. Root.initialEventIds фиксирует полный набор их event IDs, планы имеют server-only initialPlan=true и создаются вместе с root/events/receipts/intents одним commit, включая empty plans. Первичная раздача всего набора атомарна и не делится по maxHops. После commit набор/targets неизменны; новый event ID не может стать initial, child/causal mutation не дописывает initialEventIds. Writer проверяет same root/workspace и membership eventId в captured наборе; повтор event возвращает прежний план, payload не задаёт initialPlan. Поэтому только targets первоначального набора получают0, descendants не могут объявить себя первичными. Для burst каждый покрытый root должен подтверждать первоначальный target в своём snapshot; отсутствие подтверждения означает обычный hop charge для этого root, весь covered set проверяется атомарно. Charge key — stable target run/intent identity; расход1 на каждый covered root атомарен с созданием нового intent/target claims/dispatch. Повтор event, пересечение root claims и retry того же intent не создают второй charge. Root admission сам имеет0 hops; лимит ограничивает суммарную ширину и цепочку descendants, не только depth. Все входы start/child/database_event используют этот writer. Если весь covered set не помещается, нового intent нет, создаётся один durable handoff с причиной. T14-E/T27-D: два параллельных потомка, burst multi-root, bulk rows, rollback, lost ACK, repeated target и исчерпание без дальнейшей CRM mutation/нового root. T14-E: первые message.received/conversation.created одного root при maxHops=0 запускают свои initial targets без charge; другой DATABASE_EVENT того же root после commit уже descendant и при0 уходит в handoff.

<a id="design-29"></a>

## 4. Один бюджет автоматических ответов

<a id="design-30"></a>

G07 до activation задаёт responders (agent или явно выбранный набор workflows/их сочетание), maximum customer-visible replies/effects на trusted root и burst policy. Нет выбора — нельзя одновременно активировать отправляющий workflow и auto agent на маршруте. Это configurable gate; конкретный выбор пользователя не подменяется константой.

<a id="design-31"></a>

`OmniReplyBudget(workspaceId,rootKind,rootId,policyVersion,maxReplies,...)` общий для всех consumers и descendants; для сообщения rootKind=admission/rootId=rootAdmissionId, для иных событий — trusted root, описанный ниже. Customer-visible slot UNIQUE(workspaceId,rootKind,rootId,replySlot) создаётся только после генерации payload, атомарно с Command, immutable payloadHash, producer reference и effect/result mapping. До этого claim turn не расходует reply quota и slot не существует. Единственное состояние slot — bound, затем delivery outcome; отдельного reserved состояния до LLM нет. Source producer (agent/workflow/service notification) не создаёт отдельную квоту; смена stepId, run version или toolCallId её не обходит. Bound/committed/uncertain slot не освобождается автоматически при сбое. Повтор effect после commit возвращает тот же Command; другой payload конфликтует только с bound slot. До commit quota не израсходована; при crash/LLM timeout v1 завершает turn видимым handoff без автоматической повторной генерации. Неизвестный исход DB commit сначала сверяется по stable effect/Command ID; нет доказательства — visible stalled, не новая отправка. Workflow action key по step/iteration сохраняет локальную идемпотентность, но не заменяет общий slot.

<a id="design-32"></a>

Для burst turn, объединяющего admissions, участники набора фиксируются заранее; все descendants наследуют полный неизменяемый covered admission set, а не один произвольно выбранный root. При создании Command один ответ атомарно расходует соответствующий slot каждого покрытого root; блокировки budget rows по стабильному порядку. Поэтому workflow на одном из этих admissions не получает свободный независимый ответ. При невозможности получить весь набор в Command transaction нет частичного commit: turn получает terminal budget_exhausted с причиной и покрытым набором, audit + durable handoff в разрешённую очередь менеджеров. Все оставшиеся без ответа admissions явно перечислены в handoff; они не помечаются answered и не ставятся автоматически в новый turn. Если committed ответ уже есть, handoff показывает его и только оставшиеся без ответа. Автоматического split/rebuild или ожидания освобождения committed slots нет; ручное продолжение является отдельной авторизованной операцией. Повтор той же задачи возвращает тот же handoff, а не новые уведомления. Ограничение числа replies не подменяет лимиты иных CRM effects: они остаются явными классами общего root execution ledger. Новый human command — отдельная операция, не скрытое расширение autonomous budget.

<a id="design-33"></a>

## 5. Проверочные сценарии (план тестов)

<a id="design-34"></a>

| ID | Вход / гонка | Ожидаемый исход / отрицательный контроль |
|---|---|---|
| T25-A | Broad role + чужая запись, direct/execute_tool/MCP/child | Deny независимо от discovery; выключение execution guard должно сделать контроль красным |
| T25-B | Попытка code interpreter или token issuer из omni | Token не выпускается; raw sandbox callback не становится scoped execution |
| T25-D | CODE/HTTP/LOGIC_FUNCTION в omni и обычном child workflow | Publish/start/step deny; 0 token/network calls; non-omni regression работает |
| T25-E | webSearch/twitterSearch и extra tool injection | Activation error; sentTools не содержит native/неразрешённые tools; снятие guard — красный контроль |
| T25-F | DATABASE_EVENT/CRON/WEBHOOK/MANUAL → AI/CODE/SEND | Governed whole-flow validation; scoped reference до первого шага; CODE denied; missing reference denied; G17 не обходит policy |
| T14-E | Non-message trigger replay/publish + record-update cycle | Один source/root/target, pinned version; ancestry/budget сохраняются, цикл заканчивается handoff; non-governed regression |
| T25-C | Revoke после discovery / перед tool | Новое исполнение читает текущие grants и отказывает; cached allow не oracle |
| T27-A | Все pausing constants + legacy calls + runner/AI_AGENT humanInputInstructions/canAskHumans | 0 pausing tools в auto, нет занятого навсегда turn; новый constant ломает coverage test |
| T14-A | Publish v2/v3 до/после admission commit и crash до queue ACK | Один target/run для E+workflowId, pinned version неизменна; version-based key — negative control |
| T14-B | Empty plan, затем новый workflow; deactivate/reactivate перед retry | Старое событие не получает новый target; cancelled target не возрождается |
| T14-D | Retry native omni run до/после disposition, API/UI/bulk | Отказ до status/enqueue; 0 повторных шагов; ordinary Retry regression |
| T14-C | Native run удалён cleaner; replay/Redis loss | Intent evidence сохраняет единственный результат; не создаётся второй run/send |
| T27-B | Agent+workflow одновременно, budget=1 | Ровно один допустимый reply slot; другой producer denied/exhausted |
| T27-C | Burst A+B, дочерний workflow/агент и workflow для B, crash после Command commit | Общие slots защищены атомарно; replay возвращает тот же Command |
| T27-D | A+B, workflow уже занял B | 0 частичных reservations; terminal budget_exhausted + один durable handoff с unanswered A; нет autoretry/тихой потери |
| T28-A | Takeover/revoke после Command+slot commit | Текущий mode/fence всё ещё запрещает отправку; slot не означает бессрочное право |

<a id="design-35"></a>

Все строки — будущие проверки реализации и критерии review плана; ни одна не объявлена пройденным runtime-тестом. Source matrix — [automation-source-matrix.md](../../implementation/automation-source-matrix.md).

Определение: [access-control — epochs](access-control.md#epochs).

Определение: [access-control — closed-status](access-control.md#closed-status).

<a id="design-38"></a>

## Полный каталог governed подписок и политика данных

<a id="design-39"></a>

OmniWorkflowSubscription распространяется на **все** trigger types с omni capability, не только OMNICHANNEL_EVENT: persisted workflowId/versionId, triggerType/filter, governed marker и activation version. Publish/deactivate/delete/sync/import меняют durable catalog под WorkspacePolicyState FOR UPDATE. Любой governed ingress, включая CRM mutation, читает его FOR SHARE и сохраняет immutable EventDispatchPlan (в том числе empty) в той же transaction с event/root. Cache не oracle. Native listener исключает governed target по durable marker конкретной версии; он никогда не создаёт governed execution сам. Governance marker версии immutable, publish новой версии не переписывает прошлые dispatch plans. Governed job читает intent/pinned snapshot и обходит только legacy ACTIVE gate версии; current explicit deactivation/current rights всё равно дают cancel/deny. Missing plan/evidence → visible gap, не запуск по live cache. T14-E: обычная v1→governed v2/v3 между mutation/publish/listener → один pinned run либо сохранённый empty outcome, без исчезнувшего события. Пропущенные CRON occurrences после Redis loss — видимый gap, не слепой catch-up send.

<a id="design-40"></a>

Проверки разных producers одного root: T27-B. Каталог policy writers: [владелец](access-control.md#policy-writers). Root mapping определяется таблицей §3 этого документа.

<a id="design-41"></a>

Native DATABASE_EVENT listener исключает workflowId, если он есть в immutable EventDispatchPlan данного record event либо был governed в captured catalog snapshot при commit, даже если сейчас активна ordinary версия. Также он никогда не запускает текущую governed версию без intent. Ссылка на persisted DomainEvent/dispatch snapshot передаётся в trusted per-record event envelope из mutation transaction; для batch это отдельная ссылка на каждый record event, не одна версия на весь batch. Это планируемое расширение внутренних типов/publishers/consumers, не утверждение, что поле уже есть в WorkspaceEventBatch. Пользовательский payload не задаёт reference; listener проверяет workspace/event binding и неизменяемый source hash. При отсутствии обязательной ссылки для событий на мигрированном пути — visible gap/deny affected dispatch, не fallback к текущему cache. T14-E: governed v1→ordinary v2 и ordinary v1→governed v2 между commit и listener → не более одного исполнения workflowId на source event, pinned/empty outcome сохраняется.

<a id="design-42"></a>

### Каноническая идентичность, охват producers и отмена intent

Определение: [workflow-execution — workflow-ids](workflow-execution.md#workflow-ids).

Определение: [workflow-execution — coverage](workflow-execution.md#coverage).

Определение: [workflow-execution — cancellation](workflow-execution.md#cancellation).

Определение: [workflow-execution — command-cancellation](workflow-execution.md#command-cancellation).

<a id="design-47"></a>

## Хранилище запуска и целевой диалог

Определение: [implementation-spec — 3-схема--rob-764](../implementation-spec.md#3-схема--rob-764).

<a id="design-49"></a>

Для DATABASE_EVENT/CRON/WEBHOOK/MANUAL G07 resolver до первого шага фиксирует conversationId/route в trusted root ResourceScope. SEND_OMNI_MESSAGE использует защищённую root.conversationId; поиск по ConversationTarget выполняет доменный resolver с ACL. Не FIND_RECORDS по core Conversation. Отсутствующий/неоднозначный target → deny до запуска; запись target revision в captured scope обязательна.

Определение: [access-control — auto-admission](access-control.md#auto-admission).

<a id="workflow-ids"></a>

## Канонические workflow IDs

Канонические workflow IDs во всех omni keys/catalog/intents/исключениях — core.workflow.id и core.workflowVersion.id. Legacy workspaceWorkflowId/workspaceWorkflowVersionId допускаются только на входной границе: authoritative tenant-scoped mapping разрешает их в core IDs до сравнения, UNIQUE и UUIDv5; missing/ambiguous/cross-workspace mapping → deny/gap, не fallback к legacy key. Название workflowId в этом контракте всегда означает нормализованный core ID.

<a id="run-identity"></a>

## Единая automatic run identity

Одна формула для всех automatic workflow roots (message/non-message/covered burst): UUIDv5 постоянного omni namespace от канонического JSON [workspaceId, отсортированный набор пар (rootKind,rootId), coreWorkflowId]. Ни eventId, ни versionId, ни model/tool-call ID не входят. ConsumerReceipt по event/consumer сохраняет ссылку на intent; recovery всегда читает записанный runId из intent/TargetClaim, не пересчитывает из события. Полное совпадение covered roots/target возвращает тот же intent; частичное пересечение claims даёт handoff по design/09. Explicit authorized replay остаётся отдельным replayRequestId/derived execution и не становится автоматическим повтором. AutomationAdmission v1 имеет единственный server-assigned effectKind=customer_inbound; AI/workflow — consumers одного admission/root, не разные effectKind. T14: E1/E2 одного root дают один run ID и два receipts; source replay/publish/lease recovery ничего не пересчитывает по event.

<a id="coverage"></a>

## Обязательная ссылка на durable event

Для DATABASE_EVENT обязателен durable EventCoverageRegistry(workspaceId,objectMetadataId,eventKind,referenceRequired=true): активация governed подписки разрешена только после миграции и проверки всех producers данного object/event, включая generic CRUD/import/merge/lifecycle. Каждый их record event получает reference, даже при empty catalog. referenceRequired sticky: ordinary publish/deactivate/delete не снимают требование. Старые queued events без reference после включения получают visible gap/deny, не восстановление снимка по cache; обработка — отдельный explicit replay после reconciliation. Недоказанная полнота producers блокирует активацию; автоматический replay не добавляется.

<a id="cancellation"></a>

## Отмена workflow

OmniWorkflowSubscription сохраняет workflow-level cancellationEpoch и tombstone по coreWorkflowId, в том числе после ordinary publish/delete. Admission фиксирует capturedCancellationEpoch в intent. Publish/archive меняет active subscription/target eligibility для новых событий, но НЕ cancellationEpoch; ordinary publish отключает новое governed matching, не отменяя pinned intents. Explicit deactivate/delete через любой API/SDK/sync путь повышает cancellationEpoch под тем же policy/lifecycle fence и пишет audit. Start/resume/effect сравнивает captured epoch с текущей retained row: mismatch → terminal cancelled+audit/handoff; reactivation epoch не сбрасывает. Отсутствие обязательной row — gap/deny. CoreWorkflowVersionStatus ACTIVE/ARCHIVED/DEACTIVATED не является oracle отмены старого intent; hooks должны работать и при деактивации текущей ordinary версии.

<a id="command-cancellation"></a>

## Отмена созданной Command

Workflow cancellation применяется и к уже созданной исходящей Command. Она хранит immutable workflowCancellationRefs (canonical workflowId + capturedCancellationEpoch всех governed workflow в producer lineage; прямой agent без такого предка имеет пустой набор). Dispatch/recovery проверяет все refs до нового enqueue. Explicit deactivate/delete под общим UPDATE fence повышает epoch, отменяет соответствующие локальные pending Commands и пишет durable cancelRequested/outbox для dispatching/accepted/outcome_unknown; индексация workspace+referenced workflowId обязательна. Late remote enqueue покрывается tombstone userbot, too_late/timeout остаётся reconciliation; уже начатую отправку нельзя отозвать. Publish/archive не меняет refs или epoch, unrelated workflow не отменяется.

<a id="turn-lifecycle"></a>

## Жизненный цикл автономного turn

OmniAutomationTurn владеет PostgreSQL leaseUntil/heartbeatAt/progressAt и монотонным leaseFence; каждый active worker держит captured fence. Heartbeat renew — CAS по active state, owner и fence; после expiry renew запрещён. Housekeeping/startup scanner под общими policy/conversation locks и turn row lock переводит expired active turn в stalled, увеличивает leaseFence, пишет DurableHandoff с unanswered roots и освобождает partial UNIQUE в одной транзакции. Redis не oracle живости. Полученный позднее LLM result не возобновляет turn.

Каждый AI mutation, effect/slot/Command commit проверяет producer turn active, unexpired lease и совпадение captured leaseFence в той же transaction с mutation/audit. Проверка выполняется до первого эффекта и повторно на границе commit; turn row lock сериализует terminal transition и effect commit. Уже принятая Command хранит producerTurnId/capturedTurnFence: terminal transition отменяет её pending либо ставит cancelRequested для remote states; dispatch/recovery проверяет retained fence до любого нового enqueue. Уже начатый provider call только reconciles outcome, не обещает отмену. Обычное успешное завершение turn сохраняет authorization для уже committed Command через terminal=completed с тем же fence; stalled/failed/cancelled повышают fence и запрещают дальнейшие effects. Продолжение turn/новая генерация после terminal запрещены.

T27/T28: GC/LLM timeout/worker partition, scanner crash, restart и late worker после stalled → 0 новых Command/мутаций; handoff один; partial UNIQUE освобождён; поздний ACK старой отправки обновляет outcome, не возрождает turn. Это проверяется в PostgreSQL, не только mock.

Один active autonomous turn на conversation под unique constraint/lock. Новые входящие образуют pending input range; debounce window — настройка, не угаданная константа. До dispatch stale draft может supersede, но committed effects не стираются и не повторяются. После завершения активного turn новый запускается для ещё не consumed admission range. Idle/burst tests подтверждают bounded replies и конечный видимый исход (ответ или durable handoff), без бесконечного ожидания/повторов; terminal budget_exhausted не переходит автоматически в pending и не помечает unanswered admissions отвеченными.

<a id="trigger-registration"></a>

## Регистрация типа и редактора

Новый тип триггера `OMNICHANNEL_EVENT` в shared workflow trigger types, validator, server builder/core-version sync и front trigger selector/form. Виды событий v1: `message.received`, `conversation.created`, `assignment.changed`, `status.changed`. Настройка: binding/queue filter, вид события, разрешённые условия по safe projection; произвольный SQL и hidden field filtering не допускаются. Сохранение/publish проверяют права администратора и service execution policy; UI на русском показывает, какой event и route запустит процесс. Это обязательная часть ROB-769, не будущая optional интеграция.

**Регистрация OMNICHANNEL_EVENT (ROB-769).** Это настоящий новый trigger type, не строка поверх DATABASE_EVENT. Обязательный source inventory всех switch/enum/validation по WorkflowTriggerType охватывает shared base-trigger-schema/trigger unions, server trigger type/settings и builder validation; assertVersionCanBeActivated/assertTriggerSettingsAreValid; fromWorkflowTriggerManifestToTriggerOrThrow; WorkflowSchemaWorkspaceService output schema; core-version serialization/sync; front selector/editor/variables/run detail; RunWorkflowJob.incrementTriggerMetrics и MetricsKeys. В каждом месте явная обработка omni либо явный запрет неприменимой операции, не silent default. OMNICHANNEL_EVENT → отдельный счётчик запуска. Static/parameterized tests перечисляют все consumer sites, включая switch с default, для которых typecheck недостаточен.

<a id="event-projection"></a>

## Safe event projection и подавление штатного потока

Payload projection: eventId/kind, conversationId/bindingId, messageLinkId при наличии, trusted initiating principal/reference, origin/admission, causation/rootExecutionId; body/CRM fields читаются только scoped tools при выполнении, не вложены в public event. Для `message.received` нужно admission клиентского live-входящего; own echo/note/import/restore_replay не допускаются. `conversation.created` от history import также не запускает workflow; assignment/status events требуют explicit domain operation, policy и chain budget. Typed consumer напрямую создаёт run intent; он не вызывает штатный WorkspaceEventBatch listener и не переводит своё событие обратно в wildcard emitter. T14: настройка в редакторе→два workers→Redis loss/restart дают один run и action effect; publish v2/v3 между admission commit, intent enqueue и recovery, а также revoke до start проверяются; snapshot targets и stable workflowId не меняются. Импорт/echo/note дают ноль omni runs и ноль штатных listener calls; обычный не-omni database trigger продолжает работать.

<a id="repository-adapter"></a>

## Адаптер штатной транзакции

`withOmniRepositoryOptions(scope)` — trusted server adapter над тем же WorkspaceTransactionScope, без открытия новой транзакции: workspaceId/executeRawQuery/afterCommit делегируются, getRepository для allowlist message/messageThread/messageParticipant/messageChannelMessageAssociation и используемых target associations принудительно добавляет `{shouldSkipEventEmission:true}` третьим параметром. Helpers `saveMessagesWithinTransaction`, `saveMessageParticipants` и domain projection writer получают только этот wrapped scope для omni операции. Для omni запрещены `matchParticipants`/`reconcileParticipantTargets`, включая targetsOnly: они автоматически расширяют Person до Company/Opportunity. Native MessageThreadTarget пишет только domain link/unlink из canonical ConversationTarget, с isManuallyAssigned=true/isAutomaticallyAssigned=false по spec §7; транзакционные repository helpers переиспользуются без штатного вычисления desired targets. Динамический metadata name нормализуется сервером; caller не управляет allowlist. Для остальных CRM records сохраняются переданные options. Raw writes должны создавать требуемый DomainEvent/audit сами и не emit generic событие. Запрещено вызывать aggregate, который открывает собственную транзакцию или запускает postcommit matcher для omni. Email caller передаёт исходный scope и сохраняет свой emission/matching behavior. T05/T14/T16 проверяют фактические emitted events всех helper writes, rollback и отрицательный контроль удаления wrapper, не только unit mock опции.

<a id="send-action"></a>

## Действие внешней отправки

**Действие SEND_OMNI_MESSAGE, ROB-769.** Новый тип отличается от штатного SEND_CHAT_MESSAGE (внутренний чат). Точки интеграции: shared workflow action type + discriminated union workflow-action-schema.ts и новая settings schema; server workflow action enum/types, builder validation и input/output schema, WorkflowActionFactory/DI executor; front CoreActions, action metadata/icon, editor form и run-step detail. Enum/registry exhaustiveness/typecheck входят в проверку. Версия с этим action omni-governed независимо от trigger; before-first-step ingress создаёт root/reference, без reference executor отказывает. Executor вызывает только общий OmnichannelCommandService; вход conversationId обязателен и не выводится из «первого» контакта. Inputs: conversationId, text/template, authorized attachment refs; binding/route выбираются по conversation и проверяются повторно, arbitrary providerChatId запрещён. senderClass/provenance назначает server из automation context по §15.14, пользователь формы не может выбрать service_notification для обхода. Idempotency key = executionId+stepId+iteration/effectIndex, повтор шага возвращает прежний commandId/state, без нового send. Output commandId/state означает durable queued outcome, не доставку. T14/T28: editor save→validate→execute/retry; AI descendant после takeover denied; cross-workspace/hidden conversation denied; существующие SEND_EMAIL/SEND_CHAT_MESSAGE regression.

<a id="runner-terminal"></a>

## Терминальные исходы runner

ConsumerReceipt/run intent различает pending/running/completed и terminal_disposition (throttled, failed, cancelled, revoked). До вызова runner ищется stable runId. Если runner вернул/уже сохранил FAILED с hard-throttle error, intent атомарно получает terminal=throttled, audit и видимую эскалацию; повтор event не вставляет run и не сбрасывает FAILED. Ошибка/timeout с неизвестным commit сначала lookup same runId; retry create допустим только по canonical intent с доказанным отсутствием прежнего создания/эффектов; отсутствие native workflowRun после cleaner не доказательство. RunCreated/terminal evidence и tombstone переживают очистку UI runs на всё replay window; ambiguous → reconcile/stalled. Явный authorized reprocess создаёт отдельный replayRequestId, derived executionId и audit, не скрытый random retry; прежние эффекты не переисполняются автоматически. T14: hard-throttle, crash после FAILED create до disposition, Redis loss → одна FAILED запись, один terminal outcome, 0 sends; explicit reprocess отдельный.

<a id="runner-recovery"></a>

## Lease и обнаружение stalled run

**Обнаружение незавершённых запусков (ROB-769).** RunWorkflowJob ловит исключение и вызывает endWorkflowRun(FAILED) (исходник :81–94): ошибка неизвестного trigger обычно FAILED, а не обязательно вечный RUNNING. Но process crash/Redis loss может оставить RUNNING: штатный handleStuckRunningRunsForWorkspace только наблюдает. Для omni RunIntent добавляются durable executionFence/leaseUntil/progressAt, checkpoint и disposition; это расширение существующего intent, не второй workflow engine. Общий executor/RunWorkflowJob проверяет актуальный fence и terminal disposition до каждого шага/continuation и перед commit результата; собственные CRM mutation/send services проверяют его вместе с policy/control fences. Heartbeat и переходы шагов обновляют lease в PostgreSQL, Redis не источник владения. Только отдельные workflow шаги FORM/DELAY/WAIT_FOR_EVENT имеют durable wait registration/deadline и не классифицируются как stuck по отсутствию queue job. Agent pauses внутри AI_AGENT запрещены; humanInputInstructions/canAskHumans не исключение.

Recovery scanner включается при startup и периодически в рамках существующего housekeeping: обрабатывает только omni intent с истёкшим PostgreSQL lease, без действующей wait registration, под row lock/CAS и повторным чтением состояния run. Queue presence — диагностика, не доказательство живости после Redis loss. NOT_STARTED/ENQUEUED можно поставить заново с тем же runId, без повторного INSERT. Для RUNNING выбираем консервативный результат: атомарно повысить executionFence, записать terminal_disposition=stalled, audit+durable UI notification и причину/последний checkpoint; автоматически продолжать/переисполнять произвольные шаги запрещено. Native run status доводится до FAILED с кодом OMNI_RUN_STALLED; если helper не может участвовать в общей transaction, durable finalization intent в том же commit, идемпотентный reconciler доводит отображение. Domain disposition сразу видна в UI и является источником admission; старый worker не может вернуть intent в running/complete. Терминальные runs из native runner сверяются, чтобы не ошибочно пометить уже COMPLETED/FAILED; повтор scanner не создаёт вторую эскалацию.

Уже начатый внешний вызов может закончиться после stall. Его command/effect ledger сохраняет наблюдённый outcome (включая outcome_unknown) даже при терминальном run, но не разрешает следующий эффект. Отмена не обещает забрать отправленное. Долгий внешний вызов heartbeat-ит lease; остановка/partition worker допускает безопасное stall, не повтор отправки. Явный reprocess после сверки ledger использует отдельный replayRequestId по §15.17; committed/uncertain effects не повторяются автоматически. Произвольные CODE/LOGIC_FUNCTION/HTTP_REQUEST и непокрытые внешние actions под omni reference запрещены (design/09); обычные не-omni workflow сохраняют свой контракт. T14/T28: crash/Redis flush после commit CRM шага до next enqueue → один сохранённый эффект, видимая stalled-ошибка, 0 повторов; crash scanner/finalizer/restart → та же disposition; поздний worker/ACK не возрождает flow; реальные wait/delay не получают ложный stall. Порог lease/heartbeat конфигурируется и проверяется по длительности шагов; до activation обязательны положительные и отрицательные fixtures. Это реализует требование видимого исхода при сбое, а не обещание автоматического завершения любого внешнего действия.

<a id="hidden-retry"></a>

## Внутренние повторы шагов

Upstream scheduleStepRetry / stepIdsToRetry / retryCount входят в inventory, но для omni v1 автономный повтор ошибочного шага выключен: publish governed flow с retryCount>0 отклоняется; executor при error не вызывает scheduleStepRetry и через общий finalizer фиксирует FAILED/unknown effect + visible outcome. Уже попавшая в очередь retry job проверяет intent/fence и не возобновляет terminal run. Транспортные подтверждения и safe enqueue pending intent остаются по существующему контракту, это не повтор workflow effects. Обычные non-omni retries сохраняются. T14-F: retryCount>0, failure, duplicate job и Redis loss → 0 повторного исполнения шага/эффекта, видимый FAILED/stalled; negative control включения hidden scheduleStepRetry. Так lease не расширяется ради скрытых очередей retry.

<a id="producer-inventory"></a>

## Полнота всех trigger ingress

Governance/root/source-key matrix design/09 §3 нормативна для DATABASE_EVENT/CRON/WEBHOOK/MANUAL и message admissions; guarded flow не начинается широким principal. Native adapter не создаёт второй enqueue для governed target. CRM effects передают trusted causation/coveredRoots в durable record events; finite root effects/hops и route admission budget G07 обязательны, update→trigger не сбрасывает лимит. T14-E/T25-F включают все четыре триггера, replay/publish, missing reference, mixed governed/ordinary targets, цикл и partial failure до enqueue.

<a id="trusted-reference"></a>

## Trusted execution reference

Переиспользуются AgentRun/turn/history/provider integration. TrustedExecutionReference серверный: workspace/conversation/initiating principal/application/agent version/automationEpoch/restoreIncarnation/policyEpoch/rootEventId/activationVersion. Queue хранит reference ID, не редактируемый role/admin JSON. Каждый turn/tool восстанавливает reference и актуальное пересечение agent/application/caller/own policy. Потеря context не даёт Admin fallback.

<a id="catalog-integration"></a>

## Интеграция durable каталога

computeAutomatedTriggerFromWorkflowVersion возвращает null для OMNICHANNEL_EVENT в legacy cache. Durable catalog обновляется через CoreWorkflowLifecycleService и связанные SDK/sync/import paths. Bootstrap идемпотентен. Manifest roundtrip/schema/metrics и обычные EMAIL/CRON/WEBHOOK/MANUAL paths имеют regression tests.

<a id="runner-integration"></a>

## Интеграция запуска

`OmniWorkflowTriggerConsumer` передаёт CoreWorkflowRunnerService.run сохранённый runId из canonical intent/TargetClaim; перед enqueue execution reference/run intent уже durable. Pinned target и terminal evidence читаются согласно §3. Типизированный consumer не использует wildcard emitter. Штатные Message record triggers для omni данных подавлены: единственный business path — durable DomainEvent/admission с разрешённой projection. EventEmitter не единственный журнал; для внутренней CRM mutation эффект и completed фиксируются одним commit.

<a id="action-idempotency"></a>

## Локальная идемпотентность действий

Для ai_turn stableEffectKey = server-assigned effectOrdinal внутри executionId=turnId. Прежде вызова инструмента сервер durable сохраняет ordered tool-call record (provider response identity + call index, normalized capability, immutable argumentsHash, effectOrdinal) в preparedToolCalls turn/ledger. Повтор того же сохранённого вызова использует тот же ordinal; different arguments hash конфликтует. Model toolCallId — provenance/alias, не новое право выделить effect. Commit effect и ledger result атомарен и проверяет turn fence; recovery читает сохранённую invocation/result, а не повторно просит LLM сгенерировать вызов. Неизвестный commit сверяется по ledger; stalled turn не повторяет эффект. T26: потеря ACK, повтор callback, новый model tool ID и late worker → тот же outcome либо visible deny, без второй CRM mutation.


Stable workflow executionId+actionId определяют локальный ключ шага; общий reply slot имеет отдельного владельца в §4. Publish agent/workflow policy version атомарно с audit. UI показывает draft author/run/error/mode/takeover outcome.


<a id="manual-editor-ingress"></a>

## Запуск и тест из редактора

CoreWorkflowRunResolver.runCoreWorkflowVersion и все прямые callers CoreWorkflowRunnerService.run классифицируют полный snapshot flow по omni capabilities до первого шага, включая DRAFT; publish marker не единственное условие защиты. В v1 legacy runCoreWorkflowVersion для governed flow явно отказывает до runner, включая переданный клиентом workflowRunId. Обычные non-omni запускаются по прежнему контракту. Governed MANUAL использует отдельный startOmniWorkflow с idempotencyKey + payloadHash, authenticated actor, server-derived root и canonical run identity; его reference/intent создаются атомарно перед enqueue. Client runId запрещён.

Кнопка «Тест» для governed DRAFT показывает явный запрет до появления отдельного qualified synthetic режима G14; она не вызывает legacy runner. Это ограничение v1, не разрешение незаметно запустить боевой канал. Опубликованный governed MANUAL запускается через защищённую операцию; arbitrary payload не определяет principal, conversation или scope. T25-F: DRAFT/published, AI_AGENT+SEND_OMNI_MESSAGE, supplied workflowRunId, duplicate manual key/hash и ordinary workflow regression; forbidden path даёт ноль runs/tools/sends. Reference storage определяется только schema §3 (OmniExecutionReference), queue передаёт его ID.


<a id="webhook-auth"></a>

## Аутентифицированный governed WEBHOOK

WorkflowTriggerController проверяет полный flow до runner. Его legacy public GET/POST отказывает для governed flow; non-omni поведение сохраняется. Governed WEBHOOK v1 работает через отдельный signed POST /omnichannel/workflow-webhooks/:webhookBindingId ingress с OmniWebhookBinding/Credential (schema §3), без отключения самого типа триггера. Credential привязан к одному workspace/workflow и ограниченному principal/scope по G07. Пользователь тела не задаёт actor/conversation/role/root. Current principal ∩ binding scope ∩ G07 resolver определяют reference перед первым шагом.

Transport pattern подписи из §4 переиспользуется с отдельным credential namespace: HMAC-SHA256 по version + method + canonical path + keyId + signedTimestamp + idempotencyKey + SHA256(raw request bytes). Headers обязательны; query string и GET не допускаются. Сравнение constant-time; timestamp window/body size/rate limits настроены до activation, replay вне окна denied. Raw bytes сохраняются для проверки до JSON parsing; schema validation после auth. Dedup sourceKey = webhookBindingId+idempotencyKey, immutable payload hash исключает timestamp/keyId: повтор подписывается свежим timestamp, rotation не даёт нового root. Один key/different payload → conflict, same → тот же durable intent/outcome после текущей авторизации.

Администратор создаёт/ротирует/revokes credentials через policy writer с audit. Secret encrypted по существующей secret storage, выдаётся только создателю один раз, не логируется и не доступен AI/browser после создания. Old/new key overlap ограничен expiresAt; revoke немедленно запрещает новый admission и pending start/effects через current binding/principal policy fence. OmniExecutionReference сохраняет webhookBindingId/credentialKeyId, descendants наследуют их; expiresAt/notBefore ограничивают только admission нового запроса, не уже допущенный запуск. Start/tool/effect и Command dispatch проверяют active binding/current principal и явный revoke credential; штатное окончание rotation overlap не отменяет DELAY/WAIT/FORM. Explicit revoke сразу фиксируется под policy UPDATE и запрещает новые эффекты; durable outbox/finalizer переводит связанные intents/turns в terminal revoked с reasonCode=credential_revoked, audit и DurableHandoff, локальные pending Commands отменяет, remote states получают cancelRequested/reconciliation. Индексы reference→binding/key и Command/intent→reference обязательны; bounded finalization не задерживает вступление revoke в силу. Уже случившийся provider send не отменяется. Network lookup отсутствует внутри transaction. Signature/key never copy into audit/event. Binding deactivation не стирает dedup evidence. T25-F: unsigned legacy GET/POST, missing/bad/expired signature, replay, cross-tenant workflow, key rotation, revoke race, duplicate key/hash → 0 unauthorized runs/tools/sends; signed authorized request → один intent; истечение overlap во время DELAY сохраняет допущенный run, explicit revoke при том же сценарии даёт revoked/handoff и 0 новых effects. Это расширение контроллера/guards, а не утверждение о существующей webhook-auth upstream.

<a id="cron-gap"></a>

## Durable учёт пропусков CRON

OmniWorkflowSubscription хранит schedule snapshot/revision и PG cursor lastPlannedOccurrence, не Redis now. Начальный cursor определяется activeFrom при activation; обычное принятие occurrence k также берёт WorkspacePolicyState FOR UPDATE с начала транзакции. До продвижения cursor проверяется предыдущая плановая позиция k: если cursor отстаёт, missed interval (cursor,k) сначала сохраняется как schedule.gap в той же транзакции, затем принимается k/event/intent и продвигается cursor. Дубликат либо k≤cursor не создаёт новый run/gap; lookup canonical intent/outcome. Произвольный поздний job не считается текущим: срок допустимого lateness задаётся G07, за его пределом сохраняется gap без catch-up run. Startup/periodic scanner вычисляет missed UTC occurrences по сохранённым rule/timezone/revision после cursor, bounded batches; пропущенный диапазон записывает DomainEvent(kind=schedule.gap, workflow/schedule revision/window) и новый cursor атомарно под WorkspacePolicyState FOR UPDATE по общему writer протоколу (без отдельного обратного subscription lock). Stable event key по workflow+scheduleRevision+window защищает повтор scanner. UI администратора читает этот durable gap; событие не запускает business responders. Никакого автоматического catch-up send. Publish/edit/deactivate закрывает предыдущий schedule interval тем же способом до смены revision, не удаляет gap evidence. T14-E: позднее k при cursor=N и ещё не работавшем scanner не теряет N+1…k−1; Redis loss/restart, crash cursor/event, timezone/DST, schedule edit и два scanners — gap видим один раз, задним числом нет новых sends; обычно наступившее occurrence проходит обычный canonical root admission.
