# Вердикт: **needs_revision**

План в целом выполним и согласован: модель отказов, приём и отправка, own ACL, аудит, lifecycle, миграции fork, импорт и restore описаны конкретно, и почти все утверждения о коде подтверждаются исходниками. Блокируют два связанных пробела в одном месте — новый тип триггера workflow `OMNICHANNEL_EVENT` и восстановление его запусков. Сейчас на этом пути **каждый** omni-workflow застрянет в статусе RUNNING, а объявленный тест T14 этого не поймает на уровне контракта.

## Блокирующие дефекты плана

**F1 — высокая. Неполный список мест, где нужно добавить `OMNICHANNEL_EVENT`.**
- **Источник:** `run-workflow.job.ts:157-165` и `:361-376`. Сначала вызывается `startWorkflowRun` (статус становится RUNNING), затем `incrementTriggerMetrics`. Для неизвестного типа триггера эта функция бросает `'Invalid trigger type'`. При повторе задания статус уже не ENQUEUED/NOT_STARTED, и выполнение выходит на `:113-116`. Другие места с веткой `default`, которую проверка типов не поймает:
  - `compute-automated-trigger-from-workflow-version.util.ts:53-54` возвращает `null`, то есть версия не попадёт в кэш автоматических триггеров;
  - `workflow-schema.workspace-service.ts:80+` — схема выходных данных для переменных;
  - `assert-version-can-be-activated.util.ts:108` бросает исключение;
  - `from-workflow-trigger-manifest-to-trigger-or-throw.util.ts`;
  - `base-trigger-schema.ts:11` в twenty-shared — enum.
- **Спецификация:** §15.10 перечисляет только «shared types, validator, server builder/core-version sync, front selector».
- **Сценарий:** опубликован workflow с `message.received` → consumer создаёт run → `RunWorkflowJob` бросает исключение после старта → run навсегда в RUNNING, 0 шагов, нет видимой ошибки.
- **Минимальная правка:**
  - в §15.10 перечислить все `switch(trigger.type)` на сервере, включая `MetricsKeys`;
  - явно решить, что omni-триггеры не идут в `AutomatedTrigger` cache, а консьюмер использует свой реестр активных версий, который обновляется в `core-workflow-lifecycle` при activate/deactivate;
  - статический тест: каждый switch по `WorkflowTriggerType` обрабатывает `OMNICHANNEL_EVENT`;
  - T14 проверяет, что run доходит до COMPLETED.

**F2 — средняя. Не определено, что делать с omni-run в RUNNING после потери Redis или падения worker посреди шага.**
- **Источник:** `workflow-handle-staled-runs.workspace-service.ts`:
  - ENQUEUED-запуски сбрасываются в NOT_STARTED (`:84-90`);
  - зависшие RUNNING только помечаются и никогда не доводятся до конца (`:121-227`);
  - возобновление требует задания с `lastExecutedStepId` (`run-workflow.job.ts:69-74`).
- **Спецификация:** §15.10/§15.17 различают pending/running/completed и terminal-исходы. Оракул T14 — «Redis loss → один run и action effect».
- **Сценарий:** шаг закоммитил CRM-мутацию, Redis очищен до постановки следующего шага → run висит в RUNNING без эскалации. Это противоречит §1 (Redis loss входит в модель отказов) и §9 (видимая ошибка).
- **Минимальная правка:** recovery-сканер для omni-run. Если run в RUNNING без задания в работе дольше настроенного порога, есть два варианта:
  - возобновить тот же runId по сохранённым stepInfos — это безопасно, потому что ключи эффектов `executionId+stepId` уже в §15.18;
  - либо поставить `terminal_disposition=stalled` с аудитом и видимой эскалацией.

  В T14 добавить сброс Redis между шагами.

## Неблокирующие уточнения

**F3 — низкая/средняя. Неоднозначно, что проверяет `expectedRevision` при отправке.**
- По §4 воркер увеличивает revision диалога на каждом входящем, а `sendConversationMessage` принимает `expectedRevision` (06-api). По §8 этот параметр защищает только назначение и режим.
- **Сценарий:** клиент пишет, пока менеджер набирает ответ → ложный конфликт при отправке.
- **Правка:** отправка сверяет отдельный `controlRevision` (назначение/режим/статус/controlEpoch), а не последовательность сообщений. Тест: входящее между открытием composer и отправкой → отправка принимается.

**F4 — низкая. Fork-сущности нельзя помечать `@WasIntroducedInUpgrade` с fork-идентификаторами.**
- `UpgradeAwareEntityMetadataAdapter.validateDecoratorsAgainstSequence` (`upgrade-aware-entity-metadata.adapter.ts:348-368`) уронит запуск: таких шагов нет в upstream-последовательности.
- **Правка:** одна фраза в §15.5/15.8 плюс статический тест; готовность проверяется по fork ledger.

## Что подтверждено по исходникам (факты, а не допущения)

- **Миграции.** `getUpgradeSequence` группирует fast→slow→workspace по версии. `resolveStartCursor` после workspace-команды возвращает начало workspace-сегмента. Значит, тезис §15.5 «одного timestamp недостаточно» верен, и fork runner — обоснованное расширение.
- **Rematch участников.** `matchParticipantsForWorkspaceMembers` не исключает участников APP-каналов (`match-participant.service.ts:248-284`), а `matchParticipantsForPeople` исключает. Правка §15.18 по делу.
- **Подавление событий.** `WorkspaceTransactionScope.getRepository` принимает третий параметр `{shouldSkipEventEmission}`; общие helpers используют `transactionScope` — обёртка §15.10 реализуема. `headerMessageId` ищется глобально без уникального индекса — на это и рассчитаны `MessageLink UNIQUE` и префикс `omni:v1:`.
- **Обычный APP ingest.** При `applicationId=NULL` штатный `findOwnedOrThrow` и так закрывает ingest в omni-канал; `attachments: []` подтверждено.
- **Каналы и аккаунты.** Штатная синхронизация каналов опрашивает только `[EMAIL]`. `findUsableByCaller` отдаёт все WORKSPACE-аккаунты — нужен guard из §15.18. Для APP без refreshToken проверка токена проходит без ошибок.
- **Timeline.** `TimelineMessagingService` читает в обход прав (`shouldBypassPermissionChecks`) и отдаёт `lastMessageBody`.
- **Workflow runner.** `CoreWorkflowRunnerService.run` принимает `workflowRunId`; hard-throttle сразу создаёт FAILED-запись — §15.17 корректен.
- **Лицензия.** Корневой LICENSE: AGPLv3 по умолчанию; файлы с `/* @license Enterprise */` под коммерческой лицензией; MIT для shared/ui/sdk. У `build-record-share-gate.util.ts` есть Enterprise-заголовок, у `build-row-access-policy.util.ts` его нет, но он импортирует этот файл. Выводы §15.13 и G18 соответствуют тексту.
- **Тестовый workspace.** `IS_MULTIWORKSPACE_ENABLED=false` по умолчанию — gate G14 оправдан.

## Тесты реализации и продуктовые gates (не дефекты плана)

- **Gates G01–G18** как в §13: роли и воронки, аккаунты, QR/login, провайдер ИИ и бюджет, политики ответов внешнего человека и менеджера, burst, очередь, custodian, импорт и сроки хранения, нагрузка и инвентаризация SaleBot, backup, размещение, изоляция тестов, разделение ролей БД, внешние интеграции, служебные уведомления, dependency preflight.
- **Факты коннекторов** (UNIQUE в MAX `bridge_journal`, лимиты истории 24 ч/100/30, Telegram `random_id`) по исходникам Twenty не проверяются. Их нужно сверить при переносе C/H/M файлов по SHA (ROB-768).
- **Нагрузка:** `FOR SHARE` на одной строке `WorkspacePolicyState` при высокой конкуренции — проверить в T19.
- **Живой экземпляр:** feature inventory (правила, shares, webhooks) до удаления Enterprise-путей (§15.18); операционное разделение ролей БД (G15).
- **Тесты:** T01–T33 и отрицательные контроли из §11 — ещё не созданы и не запускались, как и заявлено в плане.

Сверка с прежними ID замечаний — отдельным шагом после этого ответа.
