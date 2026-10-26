# Этап 5. ИИ и рабочие процессы

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
