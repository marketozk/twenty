# Текущий остаток после авторской актуализации

Последний независимый результат [R7 B](claude-r7-reconciliation.md): 49 причин, 45 closed_in_plan, 2 major + 2 minor open. **Теперь все четыре исправления внесены в основной план; состояние addressed_pending_review.** Новый независимый verdict не получен, runtime-кода/тестов нет.

| ID | Внесено автором | Где / будущая проверка |
|---|---|---|
| H-3 major | Closed capability registry на discovery/execution/MCP/child; generic token issuer/code interpreter запрещены в omni v1 | [design/09 §2](../../design/09-automation-contract.md), spec §9/15.3, T25-A/B/C |
| M-7 major | Stable workflowId в consumer/run keys; атомарный DispatchPlan и pinned version; canonical intent переживает cleaner | design/09 §3, spec §3/5/15.10/15.17/15.19, T14-A/B/C |
| N-3 minor | Union обеих pausing констант, background pausingTools=[] | design/09 §2, spec §15.9, T27-A |
| M-13 minor | Общая reply quota/root admission и effect slots для agent/workflow/descendants, G07 activation gate | design/09 §4, spec §15.3/G07, T27-B/C |

Следующий шаг — проверить новую модель по [source matrix](../../implementation/automation-source-matrix.md) и сценариям, затем выполнить независимый полный review. До этого open не закрываются, ROB-772 In Progress, ROB-764 Todo/blocked. Авторская правка не означает доказанную runtime-корректность.

Предыдущий цикл остановлен по правилу сходимости; это запрещало повторять ту же форму без переработки, а не менять план. [Исходное предложение](automation-redesign-proposal.md) теперь историческое; его решения перенесены в нормативные документы. [Остаток R4](residual-r4.md) и исходные отзывы сохранены без переписывания.
