# Остаток после R7 и следующий метод работы

26.10.2026. **needs_revision / escalate**: 49 причин, 45 закрыты только в плане, четыре открыты. [Независимая сверка R7 B](claude-r7-reconciliation.md), [полный реестр](registry.md). Новая реализация и её runtime-тесты отсутствуют.

| ID | Риск и подтверждение | Следующее решение | Проверка |
|---|---|---|---|
| H-3 major | Code interpreter выпускает широкий application token; новый MCP HTTP request теряет captured conversation scope | Закрытый tool allowlist для discovery/execution; запрет generic delegation из omni либо отдельный bounded-token контракт | T25: direct / execute_tool / sandbox, revoke, чужая запись |
| M-7 major | receipt/run keys содержат workflowVersionId; publish после crash даёт второй запуск на событие | Stable consumer=workflowId, version immutable внутри receipt, атомарный snapshot получателей | T14: publish до/после intent, crash/replay → один run и effect |
| N-3 minor | Пропущены wait_for_duration/ask_questions и отдельный pausingTools runner path | Набор из PAUSING_TOOLS ∪ AGENT_WAIT_TOOL_NAMES, pausingTools=[] для auto omni | T27: полный каталог, legacy invocation, новые имена не обходят запрет |
| M-13 minor | Agent и workflow имеют разные reply budgets; одно событие может дать два независимых ответа | Общий budget/admission; G07 определяет responders, отсутствие выбора закрывает совместную активацию | T27: agent+workflow, simultaneous scheduling, общий slot |

Раскрытие данных и повтор отправки необратимы; accepted-risk не предлагается. Выбранные значения продуктовых gates не выдумываются. Штатный cleaner, ToolModule→RecordShare и исходный текст AGPL §13 внесены в чек-лист следующего пересмотра, а не отдельные blocker IDs.

Последовательность major 1→1→2 в R5/R6/R7 не показывает сходимости. Скилл [cross-review-convergence](C:/Users/regis/.codex/skills/cross-review-convergence/SKILL.md) требует: «если два последовательных fix-and-recheck раунда не уменьшили число открытых blocker/major ... не запускай третий раунд той же формы». Дальше допускается структурная перестройка либо эскалация; это не требование покупать подписку или принимать дефекты.

Подготовлен [конкретный структурный пересмотр](automation-redesign-proposal.md): два единых инварианта, таблица границ, набор сценариев и порядок проверки. Он пока не заменяет основной spec. Повторный fresh pass без такой переработки не запускается. ROB-772 остаётся In Progress, ROB-764 Todo и заблокирована. Рабочий Twenty не изменён.

[Исторический остаток R4](residual-r4.md) сохранён; он больше не задаёт актуальные статусы или необходимость нового разрешения на четвёртый раунд.
