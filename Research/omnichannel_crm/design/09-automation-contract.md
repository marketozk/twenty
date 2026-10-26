# Единый контракт автоматизации — авторская редакция после R7

26.10.2026. **Внесено в действующий план, ожидает независимой проверки.** Это проектируемое поведение, не готовый код. Документ вместе с согласованными разделами [implementation-spec](../plan/implementation-spec.md) заменяет противоречивые правила R7. Четыре ID остаются open у независимого reviewer; авторский статус — addressed_pending_review. Предыдущие отчёты R1–R7 сохраняются как история.

## 1. Поток и общие инварианты

DFD уровня компонентов для разработчика: показывает, где закрепляются права и разрешение на ответ. Существующие services Twenty переиспользуются за единой доменной границей.

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

Внешний текст, новый token, смена версии workflow и повтор queue job не создают новые права на данные или повторный ответ. План получателей фиксируется вместе с business admission; Redis только ускоряет исполнение. Человеческая ручная отправка сохраняет свою policy/mode/CAS, общий автоматический бюджет её не подменяет.

## 2. Закрытый каталог инструментов и передача полномочий — H-3/N-3

`OmniToolPolicyRegistry` — нормативный закрытый набор capabilities, отображённый на существующие реализации Twenty через wrappers. Запись содержит tool/capability ID, разрешённые режимы, допустимые objects/fields/relations, требования к resource scope, класс эффекта и способ аудита. Неизвестный инструмент запрещён. Одно правило применяется к direct discovery, learn_tools/get_tool_catalog, direct execute, resolveAndExecute, execute_tool, child execution и MCP ingress. Фильтр показа не заменяет enforcement; nested toolName проверяется после разрешения alias. Reference восстанавливается из серверного хранилища, не из пользовательского JSON.

| Capability v1 | Исполнение |
|---|---|
| scoped CRM read/search/aggregate | Только объекты/поля и records из captured ResourceScope ∩ current grants; counts и related labels также фильтруются |
| scoped CRM create/update/delete/stage transition | Общие domain services, текущие права, control/policy fences, effect ledger и audit; deletion не bypass lifecycle |
| read conversation / approved knowledge / protected files | Parent ACL и provenance, без выдачи широких storage credentials |
| send client message | Только OmnichannelCommandService + общий reply budget; произвольный route запрещён |
| start approved workflow / child agent | Зарегистрированный target и наследуемые reference/root admission/budget; descendant scope только сужается |
| handoff / create task / internal note | Завершённая доменная операция по правам, не удерживающий auto-turn pausing tool |

Raw `http_request`, `send_email`, `draft_email`, `find_connected_accounts`, `create_calendar_event`, `create_file_upload`, `complete_file_upload`, `code_interpreter`, `save_campaign`, `share_record`, logic-function execution и любые прочие upstream tools не становятся разрешёнными из role flag. Для omni v1 они не рекламируются и запрещены в executor, пока для них нет отдельной scoped capability записи с проверенным wrapper и тестами. Вспомогательные search_output/extract_json_paths/search_help_center тоже не исключение из closed registry. Это не запрет нужных бизнес-операций CRM: они доступны через перечисленные безопасные capabilities; расширение каталога является явным изменением политики/контракта, а не догадкой модели.

Omni v1 **не выпускает generic application access tokens**, не предоставляет sandbox credentials и не позволяет пользователю подставить application token как продолжение captured execution. CodeInterpreterTool/issuer запрещаются на пути omni до выпуска token. Новое HTTP/MCP обращение от исполнения разрешается только через серверный internal dispatcher с verified execution reference и той же policy, иначе deny; общий MCP для обычных пользователей Twenty сохраняет прежний auth, но не считается способом продолжения omni-run. Отдельный будущий bounded-token протокол потребует собственного решения и тестов; один TTL не достаточен.

Для auto omni исключаются все имена `keys(PAUSING_TOOLS) ∪ AGENT_WAIT_TOOL_NAMES`, включая legacy ask_questions и wait_for_duration, плюс background AgentRunner получает `pausingTools: []`. Статический inventory проверяет отдельные injection paths и новые имена; имя не обязано присутствовать в advertised catalog, чтобы быть запрещённым на исполнении. Assist оформляет запрос к менеджеру через завершение turn/handoff; slot не остаётся занят ожиданием.

## 3. Стабильная раздача событий — M-7

`EventDispatchPlan` имеет UNIQUE(workspaceId,eventId), captured policy/activation version, immutable targets и state (включая явный empty/suppressed). Каждый workflow target содержит stable workflowId и pinned workflowVersionId; **consumerId = omni-workflow:{workflowId}**, UNIQUE(workspaceId,eventId,consumerId), runId = UUIDv5(workspaceId,eventId,workflowId). Версия — payload, никогда часть idempotency key. Agent target использует стабильный automation policy ID, а не model/tool-call ID. Payload hash исключает повтор с подменой содержания.

При первом business admission план, все target receipts/run intents и общий reply budget фиксируются атомарно вместе с admission. Публикация/деактивация подписок сериализуются с этой транзакцией через существующий WorkspacePolicyState fence: admission SHARE, lifecycle UPDATE до изменения каталога; порядок locks соответствует §15.9. Ни один worker не выбирает список текущих подписок заново при replay. Пустой план тоже сохраняется: поздняя публикация не делает старое событие новым. Для событий до установки автоматизации activation boundary не позволяет задним числом создать effects. Размер набора ограничен конфигурацией и квалифицируется до activation; ошибка планирования не выдаётся за завершённую обработку.

Publish v2 после сохранения target v1 не создаёт второй target и не меняет pinned v1. Деактивация до начала target переводит его в cancelled/denied с audit; reactivation не оживляет его автоматически. Уже принятый run использует сохранённый flow с текущими access/mode fences; запрещённый эффект не выполняется. Explicit replay требует отдельной пользовательской операции и replayRequestId с предупреждением о committed/uncertain effects; это не автоматический retry E под новой версией.

RunIntent хранит runCreatedAt/created evidence, runId, pinned version, terminal disposition и refs на effect ledger независимо от строки native workflowRun. Raw cleaner Twenty может удалять отображаемый COMPLETED/FAILED run только при сохранённом canonical evidence; удаление не сбрасывает admission/receipt/tombstone. Отсутствие native строки само по себе никогда не разрешает повторный create/run. Recovery сначала читает intent; ambiguous creation reconciles по стабильному ID/creation evidence, unresolved → visible stalled, не повтор эффекта. Retention intents/tombstones не короче допустимого replay/recovery window; событие старше доступного evidence закрывается gap/quarantine. Read paths этих данных сохраняют собственный ACL.

## 4. Один бюджет автоматических ответов — M-13

G07 до activation задаёт responders (agent или явно выбранный набор workflows/их сочетание), maximum customer-visible replies/effects на root admission и burst policy. Нет выбора — нельзя одновременно активировать отправляющий workflow и auto agent на маршруте. Это configurable gate; конкретный выбор пользователя не подменяется константой.

`OmniReplyBudget(workspaceId,rootAdmissionId,policyVersion,maxReplies,...)` общий для всех consumers и descendants. Customer-visible slot UNIQUE(workspaceId,rootAdmissionId,replySlot) резервируется транзакционно до генерации отправки; reservation содержит producer reference и immutable effect/Command mapping. Source producer (agent/workflow/service notification) не создаёт отдельную квоту; смена stepId, run version или toolCallId её не обходит. Зарезервированный/committed/uncertain slot не освобождается автоматически при сбое. Повтор effect возвращает тот же результат, другой payload → conflict/reconciliation. Workflow action key по step/iteration сохраняет локальную идемпотентность, но не заменяет общий slot.

Для burst turn, объединяющего admissions, участники набора фиксируются заранее. Один ответ атомарно расходует соответствующий slot каждого покрытого admission; блокировки budget rows по стабильному порядку. Поэтому workflow на одном из этих admissions не получает свободный независимый ответ. При невозможности получить весь набор нет частичного commit. Ограничение числа replies не подменяет лимиты иных CRM effects: они остаются явными классами общего root execution ledger. Новый human command — отдельная операция, не скрытое расширение autonomous budget.

## 5. Проверочные сценарии (план тестов)

| ID | Вход / гонка | Ожидаемый исход / отрицательный контроль |
|---|---|---|
| T25-A | Broad role + чужая запись, direct/execute_tool/MCP/child | Deny независимо от discovery; выключение execution guard должно сделать контроль красным |
| T25-B | Попытка code interpreter или token issuer из omni | Token не выпускается; raw sandbox callback не становится scoped execution |
| T25-C | Revoke после discovery / перед tool | Новое исполнение читает текущие grants и отказывает; cached allow не oracle |
| T27-A | Все pausing constants + legacy calls + отдельный runner injection | 0 pausing tools в auto, нет занятого навсегда turn; новый constant ломает coverage test |
| T14-A | Publish v2/v3 до/после admission commit и crash до queue ACK | Один target/run для E+workflowId, pinned version неизменна; version-based key — negative control |
| T14-B | Empty plan, затем новый workflow; deactivate/reactivate перед retry | Старое событие не получает новый target; cancelled target не возрождается |
| T14-C | Native run удалён cleaner; replay/Redis loss | Intent evidence сохраняет единственный результат; не создаётся второй run/send |
| T27-B | Agent+workflow одновременно, budget=1 | Ровно один допустимый reply slot; другой producer denied/exhausted |
| T27-C | Burst A+B и workflow для B, crash после Command commit | Общие slots защищены атомарно; replay возвращает тот же Command |
| T28-A | Takeover/revoke после slot reservation | Текущий mode/fence всё ещё запрещает отправку; slot не означает бессрочное право |

Все строки — будущие проверки реализации и критерии review плана; ни одна не объявлена пройденным runtime-тестом. Source matrix — [automation-source-matrix.md](../implementation/automation-source-matrix.md).
