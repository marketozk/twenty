# Этап 5. ИИ и рабочие процессы

Нормативные определения: [индекс владельцев](contracts/README.md). Этот документ содержит производные работы и проверочные сценарии; изменение семантики вносится у владельца и затем отражается в сценарии.

Действующий план: [единый контракт](../design/09-automation-contract.md) и [source matrix](../implementation/automation-source-matrix.md). EventDispatchPlan/receipts фиксируют stable consumerId и pinned version атомарно; общий reply budget охватывает agent/workflow. Closed tool registry, запрет generic token issuance и полный pausing inventory обязательны. Текущий verdict — [review-result](cross-review/review-result.md).

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Зависимости: 2–4. Статус: не выполнен. Полный конечный объём включает auto replies и действия CRM, не только drafts.

Подтверждённый call graph и изменения: [AI/workflow source audit](../implementation/ai-workflow-source.md). AgentRun/ToolContext/generic CRUD получают trusted domain reference и общий mutation fence; workflow context проверяет его до fallback стандартного приложения. Типизированный OMNICHANNEL_EVENT trigger и OmniWorkflowTriggerConsumer получают DomainEvent admission/projection; generic EventBatch для omni подавлен. Контракт редактора, run intent и stable workflowRunId — implementation-spec §15.10. Штатные stream claim/cancel и BullMQ recovery переиспользуются, но не считаются готовой гарантией takeover или дедупликации внешних событий.

**Существующие:** server `engine/metadata-modules/ai/ai-agent-execution/services/agent-run.service.ts`, `utils/build-agent-role-permission-config.util.ts`; `modules/workflow/workflow-trigger/automated-trigger/listeners/workflow-database-event-trigger.listener.ts`; `workflow-executor/services/workflow-execution-context.service.ts`; `workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service.ts`; `engine/workspace-event-emitter/{workspace-event-emitter.ts,types/workspace-event-batch.type.ts}`.

**Новые:** `modules/omnichannel/ai/{conversation-agent.service.ts,conversation-tool-policy.ts}` и `workflow/` adapters/actions; соответствующие test fixtures и UI mode/takeover controls.

1. Trusted scope: actor/application/workspace/conversation/policy version/epoch. Существующий AgentRunService с пересечением ролей; generic tools также должны соблюдать conversation scope. Потеря scope в queue/function — отказ, не admin fallback.
2. Разрешённый CRM/knowledge context; новое сообщение не может подменить role/tool arguments. Не вводить отдельную LLM платформу. Модель/key/budget остаются конфигурацией, секрет вне Git; тесты сначала с stub provider.
3. Human/assist/auto, обновление epoch, cancel pending, повторная проверка перед каждым изменяющим tool/send. Внутренние notes не отправляются; accepted external send не обещать отозвать задним числом.
4. События и workflow action «Отправить в диалог»: единый CommandService, command id от execution/action ID. Consumer pending/running/completed, replay после crash; causation и own echo не запускают циклы.
5. Import/replay подавляет omni generic events, включая стандартные CREATED/UPDATED triggers. Typed consumer допускает только разрешённые DomainEvent; в общий emitter их обратно не публикует. Старый sendInboxMessage остаётся внутренним уведомлением. Подавление ИИ не опирается только на shouldAssistantReply флаг AI Inbox.
6. Отдельная role/policy version draft-agent; публикация атомарно меняет активную версию, сохраняет audit. Общие административные role changes отдельно проверяются.
7. Epoch/policy check + CRM mutation + audit в одной транзакции под общим fence с takeover/revoke, включая generic AI tools и conversation-triggered workflow. Постоянный integration test приостанавливает check/write и проверяет оба порядка takeover и отсутствие deadlock. Статические точки реализации установлены; отдельный предварительный прототип не требуется.

**Verify:** injection fixtures без внешних действий, cross-client tools denied, role revoke mid-run, takeover barrier, 2 workers на одном событии, runtime timeout/unknown, импорт не запускает ни AI, ни обычный record trigger. Каждый изменяющий tool имеет audit инициатора/результата. Сначала тесты из design/04, затем e2e со stub и после настройки отдельного provider — тестовый чат.

**Done when:** auto и assist работают обоими каналами в разрешённых сценариях, человек останавливает будущие AI actions, ни один tool/экспорт не раскрывает чужую область.

**Rollback:** переключить conversations в human, инвалидировать epoch, дренировать dispatch; не выключать аудит/чтение истории и не пересылать неизвестные команды повторно.


Четвёртый раунд: sender×mode/provenance (§15.14), protected AI/workflow artifacts (§15.12), terminal throttled disposition (§15.17). Takeover не обходится новой workflow-командой с новым epoch.

SEND_OMNI_MESSAGE интегрируется в shared schema, server factory/validation/DI и front editor/registry; trusted sender provenance и стабильный effect key по §15.18. Это отдельное действие от внутреннего SEND_CHAT_MESSAGE.

Обязателен §15.19: trigger switches/metrics/activation/schema, durable OmniWorkflowSubscription, run watchdog с fenced terminal stalled при потере очереди, без автоматического повторения произвольных эффектов. T14 до COMPLETED в норме и до видимого исхода при отказе.

R8: Omni reference обязателен для workflow descendants независимо от trigger type; closed action table и final sentTools guard, native/pausing overrides, запрет обычного Retry omni runs, полный inherited admission set и durable budget_exhausted handoff — design/09. Это авторские исправления после targeted review, ещё не full pass.

R11: [таблицы](decision-tables.md) дополняют whole-flow governance. Core workflow/version IDs нормализуются до keys; sticky referenceRequired и coverage всех producers до activation; cancellationEpoch меняется при explicit deactivate/delete, но не publish/archive. Immutable workflowCancellationRefs (включая governed ancestors) проверяются при Command dispatch/recovery, remote cancel требует journal proof. T14/T28 проверяют эти границы вместе, а не только отмену runner.

## Идентичность запуска и non-message target

Создать отдельные OmniWorkflowRunIntent/OmniWorkflowTargetClaim по §3, не отождествлять intent с ConsumerReceipt. T14: conversation.created и message.received одного root/target дают два receipts и один запуск, повтор и cleanup native run его не дублируют. G07 resolver фиксирует root.conversationId/route до первого шага; non-message workflow использует domain query разрешённых ConversationTarget, missing/multiple deny. Captured edge revision проверяется при каждом эффекте.

Схема Turn/Effect/Knowledge и UNIQUE приведены §3; tenant/role ограничения действуют до retrieval. Не добавлять новую платформу ИИ или векторный индекс без необходимости. Не вводить acknowledge_unresolved: неизвестная human send блокирует auto согласно существующим таблицам; UI объясняет pending_human_commands и доступный ручной разбор.

F-04 summary/rephrase по явному запросу менеджера разрешены и в human mode как read-only assist; scoped artifact, без Command/customer reply slot и mutating tools. T12/T25 проверяют запреты и revoke перед выдачей; autonomous AI в human остаётся отключён.

Run identity: [единственное определение](contracts/workflow-execution.md#run-identity). T14 проверяет два event receipts/один run и восстановление по intent.
Реализация и проверки [AI turn lifecycle](contracts/workflow-execution.md#turn-lifecycle) и [stable effect invocation](contracts/workflow-execution.md#action-idempotency): PostgreSQL heartbeat/scanner/fence, late-worker negative control, один DurableHandoff, ReplayRequest и сохранённый effect ordinal. T26–T28 проверяют crash до/после terminal и Command commit, без повторной генерации/эффекта. G13 требует решения владельца об unknown-send liveness до activation; решение не принято планом.


OmniExecutionReference и reference FK вводятся по schema §3 до activation. Закрыть legacy/editor DRAFT bypass по [MANUAL ingress](contracts/workflow-execution.md#manual-editor-ingress); T25-F проверяет прямой resolver, supplied runId и ordinary regression.


Реализовать signed governed WEBHOOK и credential lifecycle по workflow-execution#webhook-auth, сохраняя обычные webhook. Durable CRON cursor/gap по #cron-gap. T25-F/T14-E проверяют current auth/revoke, rotation idempotency, lost Redis и отсутствие catch-up sends.

ROB-764 уже вводит schema/disabled v0 AutomationPolicy/Version; ROB-769 добавляет full publish/validation и общий root effect/hop ledger по owners automation-policy-version/root-effect-budget. CLASSIFY явно deny. Unassigned automatic assist использует scoped service principal и artifact ACL; internal notes только по G04. T14/T25/T27 покрывают concurrent quota, publish fences и lost webhook secret response.

## LOG084 producer coverage — explicit Person creation

Internal `createPersonForOmniIdentity` / `setOmniIdentityPerson` create mode now writes native Person, identity/participants, audit and receipt atomically. Generic Person events are suppressed. Governed Person-created DomainEvent + target intents and current-authorized visible event delivery are NOT implemented. Add this exact writer to EventCoverageRegistry/producer coverage before Person-governed subscription activation; include the LOG085 live `applyOmniIncomingTextReceipt` automatic creation caller too (same-scope child operation, imported duplicate overlap). Audit is not a substitute for the visible-event requirement in sending-ui. Verify explicit creation after history emits one governed event/intent, replay emits none, rollback emits none, and raw history/restore never creates Person or launches responders. Owners: sending-ui#203 prose, workflow-execution guarded CRM mutation and producer activation gate; phase5 ROB-769. Full runtime ACL stays ROB-766.

## LOG087 producer coverage — administrative parent destroy

Internal `destroyOmniCrmParent` now commits Person/Company delete, identity/target detach and root audit/receipt. Generic events are suppressed. Include this exact writer and its retained scope in governed delete event/target-intent and current-authorized visible-event coverage before activation. Replay/rollback emit none; an audit entry is not a governed event. General native lifecycle expansion remains ROB765, runtime ACL ROB766.
