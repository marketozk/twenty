# Предложение следующего шага: единое управление автоматизацией

**Историческое предложение после R7. Его решения теперь внесены в [design/09](../../design/09-automation-contract.md) и основной spec. Текст ниже сохраняет исходное предложение; текущий статус — addressed_pending_review, не pass.**

26.10.2026. Предложение после R7, **не замена действующей спецификации и не pass**. [Остаток](residual.md), [независимая сверка](claude-r7-reconciliation.md). Scope остаётся прежним: Telegram/MAX, совместная CRM, широкие прикладные возможности ИИ, workflow; без робота/подписки/деплоя. Нужна структурная переработка контрактов вместо ещё одного добавочного раздела с исключениями.

## 1. Два общих инварианта

1. Любой вызов, порождённый omni automation, сохраняет immutable execution reference и текущее пересечение прав. Новый HTTP-запрос, дочерний agent/tool/MCP и токен не могут превратить scoped исполнение в обычный широкий application principal.
2. Входящее admission имеет один долговечный план получателей и общий бюджет ответов. Публикация новой версии workflow, рестарт и повторная генерация ИИ не создают новое право ответить на старое событие.

## 2. Конкретная предлагаемая модель

| Граница | Предлагаемый единый контракт | Что перестаёт быть источником истины |
|---|---|---|
| Tools | OmniToolPolicyRegistry: исчерпывающие capability ID, allowed modes, resource projection, effect class; одна проверка для discovery и execution | Наличие инструмента в upstream catalog или один role flag |
| Прямой вызов / execute_tool / MCP / child | Вход требует trusted reference; по нему заново проверяются actor, captured scope, актуальные grants/epochs и capability | Prompt, user-supplied role/reference или новая широкая application сессия |
| Sandbox/delegation | В первой реализации omni не выпускает generic application tokens и не предлагает code_interpreter. Возможное последующее включение требует отдельного bounded-token контракта и серверного enforcement; raw HTTP/send_email/share_record тоже не обходят command/effect service | Пятиминутный срок токена как замена ограничения полномочий |
| Автономные паузы | Исключить PAUSING_TOOLS ∪ AGENT_WAIT_TOOL_NAMES в каталоге и executor; background runner pausingTools=[] | Частичный вручную перечисленный список имён |
| Распределение event | Одна transaction фиксирует immutable список eligible consumers и pinned versions для admission. consumerId=omni-workflow:{workflowId}; UNIQUE(workspace,eventId,consumerId), runId=UUIDv5(workspace,eventId,workflowId) | workflowVersionId как ключ дедупликации |
| Republish/deactivate/recovery | Уже созданный target/intent не пересоздаётся под новой версией; pinned version неизменна, deactivation проверяется по явно выбранной lifecycle политике без нового исполнения | Повторный выбор всех текущих subscriptions при replay |
| Агент + workflow | Один reply budget/admission и общие effect slots, независимо от producer. G07 определяет владельца/разрешённый набор responders; без выбора совместная отправляющая конфигурация не активируется | Раздельные несвязанные лимиты OmniAutomationTurn и workflow |
| Retention | Intent/tombstone хранит runCreated/final disposition/ledger refs на согласованное replay window; очистка native workflowRun не создаёт право на новый run | Отсутствие строки workflowRun как доказательство «никогда не запускался» |

Широкие бизнес-возможности ИИ сохраняются: чтение/изменение CRM, сообщения, запуск разрешённых процессов реализуются через проверенные capabilities и существующие Twenty services. Это не предложение заменить цель режимом только черновиков. Значения G07 и других продуктовых gates не выдумываются за владельца.

## 3. Порядок переработки и проверяемый результат

1. Снять единую source→entrypoint→principal→reference→effect matrix для ActionToolProvider/ToolProviderService/execute_tool/MCP/code interpreter/agent runner и workflow lifecycle/event consumer/runner/cleaner. У каждого маршрута одно явное решение: scoped wrapper, deny или existing safe primitive. Отдельно включить nested инструменты и auth token issuance.
2. Переписать соответствующие разделы §3/5/9/15.3/15.9/15.10/15.14/15.17/15.19 вокруг общей модели; убрать устаревшие version-based keys и независимые budgets. Не дописывать новый §15.20 поверх противоречий. Согласовать API, схемы, coverage и phase1/5.
3. Составить конечные таблицы сценариев: прямой/delegated вызов × режим × scope/revoke; event dispatch/crash × publish/deactivate × версия; один/несколько responders × бюджет; native run deleted × immutable intent. Для каждого исход allow/deny/one effect/visible uncertainty; обязательные отрицательные контроли.
4. Сначала провести целевую проверку этой модели по source matrix и всем старым ID H-3/M-7/N-3/M-13. Затем один свежий полный проход и reconciliation всего плана. Новая серия слепых проходов без изменения структуры не запускается.
5. После положительного планового вердикта ROB-764 начинает реализацию контрактов и executable tests. Production gates, реальная переписка и переключение SaleBot отдельно; написанный план не доказательство выполненных T01–T33.

## 4. Непринимаемые допущения

Не считать короткоживущий token безопасным сам по себе; не маскировать dropped event успешным ACK; не отключать очистку навсегда ради дедупликации; не перепосылать uncertain effect; не объявлять весь Enterprise-каталог собственным. Release checklist включает проверку Corresponding Source offer по тексту AGPL §13 для изменённой версии с сетевыми пользователями, без заявления о юридической сертификации текущего экземпляра.
