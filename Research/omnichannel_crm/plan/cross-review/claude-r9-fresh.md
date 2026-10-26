# Вердикт: needs_revision

План целиком согласован и сильно детализирован. Ссылки на исходники, которые я проверил, подтвердились. Блокирующих дефектов два, оба локальные, и каждый правится одним-двумя абзацами контракта. Ещё три замечания не блокируют.

## Блокирующие дефекты плана

**F1. Medium, блокирует. `controlEpoch` одновременно служит CAS для интерфейса и барьером для автоматики, поэтому обычное назначение отменяет ответ ИИ, а судьба человеческих команд не определена.**
- Где: `plan/implementation-spec.md:79` (pending: «Нет send без текущих прав/epoch»), `:424` (takeover отменяет только non-human команды), `:428` (§15.15: для automation intent нужно точное совпадение controlEpoch), `:489` (§15.19: назначение, участники и статус увеличивают controlEpoch).
- Сценарий 1. Первое сообщение нового клиента порождает `message.received` для агента и `conversation.created` для workflow, который назначает менеджера (оба события есть в §15.10). Назначение увеличивает controlEpoch. Агент запомнил прежнее значение, его Command или проверка при dispatch не проходит, admission уже израсходован. Клиент остаётся без ответа, хотя takeover не было. Что при этом происходит с turn (повторная оценка, handoff или ошибка), в контракте не сказано.
- Сценарий 2. Менеджер A отправил сообщение, команда в состоянии pending. Руководитель в этот момент переназначает диалог. По `:79` dispatch требует текущий epoch, и уже принятое человеческое сообщение не уходит. По `:424` отменяются только non-human команды. Это прямое противоречие.
- Исправление: разделить барьеры. `controlEpoch` остаётся CAS для команд управления. Отдельный `automationEpoch`, или явный перечень событий, увеличивается только при смене mode, takeover и действиях по managerReplyPolicy. При dispatch человеческая команда проверяет текущие права, маршрут и mode-политику, а не равенство controlEpoch. Нужно также задать исход для AI-turn при stale epoch: повторная авторизация при всё ещё auto и неизрасходованном slot либо durable handoff.
- Тест (расширение T13/T24): workflow назначения на `conversation.created` идёт параллельно с генерацией AI. Результат: ровно один ответ или явный handoff по выбранному правилу, takeover по-прежнему даёт 0 AI-отправок. Переназначение между созданием и dispatch человеческой команды даёт отправку, если права сохранились.

**F2. Medium, блокирует. Момент резервирования reply slot описан противоречиво; при одном из прочтений любой сбой во время генерации LLM расходует бюджет.**
- Где: `design/09-automation-contract.md:85` (slot резервируется «до генерации отправки», а зарезервированный slot «не освобождается автоматически») против `plan/implementation-spec.md:271` (неизменяемый payloadHash; автоматически не освобождаются только committed и uncertain slots).
- Сценарий: slot зарезервирован, затем LLM упирается в timeout или worker падает (оба случая входят в модель отказов). Восстановленный turn генерирует другой текст и получает «другой payload → conflict». При maxReplies=1 итог budget_exhausted и handoff, хотя Command не было и ничего не отправлялось. Если slot резервируется ещё без payload, «immutable payloadHash» в этот момент неопределим.
- Исправление: явно ввести два состояния slot. `reserved`: без payload, принадлежит стабильному turn/execution identity, тот же identity может переиспользовать его после истечения lease, если Command нет. `bound`: payloadHash и commandId записаны в одном commit с Command, автоматически не освобождается никогда. Конфликт по payload возможен только для `bound`.
- Тест (T26/T27): crash после резервирования, но до Command, затем recovery даёт один ответ. Crash после Command commit даёт тот же Command. Отрицательный контроль: чужой producer не может забрать `reserved` slot.

## Неблокирующие замечания (исправить в тексте)

**F3. Medium. Restore возвращает к жизни отозванные права и сессии.**
- Где: `plan/implementation-spec.md:204`, `:285` (fence при restore касается только отправок и автоматики).
- Сценарий: сотрудника уволили после момента backup. После восстановления его grants, membership, сессии и API keys снова действуют. Аудит отзыва тоже потерян вместе с БД.
- Исправление: добавить в runbook G12 и §15.4 шаги. Восстановленный экземпляр открывается с fence интерактивного и API-доступа. Все сессии инвалидируются (ротация signing secrets), API keys отключаются до сверки. Администратор сверяет роли и grants по внешнему свидетельству до снятия fence.
- Тест (T18/T29): revoke после snapshot, затем restore. Отозванный principal не читает данные до reconciliation.

**F4. Low. Штатный TrashCleanup не попал в lifecycle-перечень.**
- Где: `plan/implementation-spec.md:251`, `:261`; в `implementation/bypass-candidates.md:58` он есть только как «classify».
- Факт по коду: `packages/twenty-server/src/engine/trash-cleanup/services/trash-cleanup.service.ts:104-133` обходит все объекты workspace с bypass и делает hard delete. Удаление Person через DB-каскад ставит `messageParticipant.personId` в SET NULL (`compute-message-participant-standard-flat-field-metadata.util.ts:399`). `ExternalIdentity.personId` при этом остаётся висячим, обязательного аудита у такого удаления нет.
- Исправление: включить TrashCleanup в §15.1/§15.2 и в порцию B аудита. Нужны аудит destroy, перевод ExternalIdentity в unbound и исключение omni-объектов.
- Тест: дополнить T22.

**F5. Low, product gate. Подпись менеджера для клиента.** В `requirements.md:49` сказано, что представление имени менеджера клиенту «настраивается отдельно». В спецификации нет ни контракта, ни gate для этого. Достаточно добавить gate (по умолчанию без подписи) или явно вынести в v2.

## Тесты для реализации и product gates (не дефекты плана)

- T19: конкуренция за `WorkspacePolicyState FOR SHARE` и MultiXact при каждом чтении. Мерить на выбранной нагрузке, это уже заявлено.
- T14: штатный `handleStaledRunsForWorkspace` сбрасывает ENQUEUED в NOT_STARTED без CAS (`workflow-handle-staled-runs.workspace-service.ts:84`). Для omni-runs проверить, что executionFence и lease не допускают двойного исполнения.
- G01–G18 корректно оставлены за владельцем. Значения за него я не подставлял. G05/G06/G07 обязательны до auto.
- Все T01–T33 и T25/T27/T14-A…F остаются будущими тестами, ни один не запускался.

## Что подтвердилось по исходникам (pinned рабочее дерево)

- Третий параметр `getRepository` с `shouldSkipEventEmission` есть (`workspace-transaction-scope.type.ts:13`).
- `saveMessagesWithinTransaction` ищет существующие сообщения по `headerMessageId` по всему workspace (`messaging-message.service.ts:83-89`). Значит, namespaced header и reserved prefix действительно нужны.
- `CoreWorkflowRunnerService.run` принимает `workflowRunId` (`core-workflow-runner.service.ts:53`), hard throttle создаёт FAILED run (`:115-147`).
- `RunWorkflowJob` в catch вызывает `endWorkflowRun(FAILED)` (`run-workflow.job.ts:81-94`).
- `retryWorkflowRun` переводит FAILED в RUNNING и ставит job в очередь (`workflow-runner.workspace-service.ts:289-381`).
- Stuck RUNNING runs только помечаются, не завершаются (`workflow-handle-staled-runs.workspace-service.ts:121-227`).
- `getUpgradeSequence` группирует команды fast→slow (`upgrade-sequence-reader.service.ts:39-51`).
- `build-row-access-policy.util.ts` импортирует `buildRecordShareGate` (`:5`, `:60`).
- Существуют `PAUSING_TOOLS`, `AGENT_WAIT_TOOL_NAMES`, `withoutAppChannelParticipants`, `CommonMergeMany`, `computeAutomatedTriggerFromWorkflowVersion`.
- У ConnectedAccount nullable `applicationId` и `connectionProviderId` с CASCADE, есть поле `scope`.

## Что прочитано и ограничения

- **Полностью:** requirements.md; implementation-spec.md (строки 1–500, §1–15.20); design/09; coverage.md; phase_1…phase_7; design/02, 05, 06, 07, 08; open-questions.md; implementation/license-inventory.md; implementation/automation-source-matrix.md.
- **Сознательно не читал:** cross-review/, registry, DEVLOG, STATUS, DOCUMENT-AUDIT, SKILLS-AUDIT, баннеры со статусами review.
- **Не читал полностью:** integration-map, access-source, transactions-audit-source, ai-workflow-source, research-connectors.
- **Не проверял:** исходники внешних коннекторов (C/H/M); Twenty целиком сверял только выборочно.
- Это проверка плана, не runtime. Ни один тест не запускался, о прохождении не заявляю.
