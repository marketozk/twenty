# Модель данных и инварианты

Имена `Omni*` — предлагаемые сущности, не найденные готовые таблицы. Новые данные находятся в PostgreSQL Twenty с изоляцией workspace и миграциями его lifecycle. Для транзакционно связанных записей используется та же workspace transaction scope, что у Message; не разносить их по разным БД. Регистрация служебных сущностей не должна открыть автоматический публичный CRUD: запись через доменные команды; проверка generic API включена в приёмку.

## Источники истины

| Данные | Владелец |
|---|---|
| Клиент/компания/сделка/задача | Существующие CRM objects Twenty |
| Текст подтверждённой переписки, даты, участники и CRM targets | Message/MessageThread, MessageParticipant, MessageChannelMessageAssociation и targets Twenty |
| Состояние общения и разрешение следующего действия | OmniConversation + policy Twenty |
| Намерение отправить и автор из CRM | OmniOutgoingCommand Twenty |
| Состояние вызова Telegram/MAX и receipt провайдера | Connector journal / adapter journal, проекция состояния в Twenty |
| Сессия Telegram/MAX | Соответствующий юзербот; не CRM-таблицы и не браузер |
| Исполнение ИИ | Существующие agent run/history Twenty; это не второе хранилище клиентской истории |

## Сущности

| Сущность | Основные поля / связи | Ограничения |
|---|---|---|
| OmniAccountBinding | workspaceId, platform, connectorAccountId, connectedAccountId, messageChannelId, routeGeneration, capabilities, status | Уникальный platform+account внутри workspace; один transport account не становится аккаунтом другого workspace по входящему payload. Доступ к connectedAccount проверяется сервером. |
| OmniExternalIdentity | bindingId, providerPeerId, personId, verificationSource | Явная привязка клиента. Не объединять по имени/username. Один Person может иметь несколько подтверждённых identity. |
| OmniConversation | bindingId, providerChatId, messageThreadId, assigneeWorkspaceMemberId, status, mode, revision, controlEpoch, policyVersion | UNIQUE(bindingId, providerChatId); маршрут не меняется при смене контакта. Изменения состояния через команды. |
| OmniConversationMember | conversationId, workspaceMemberId, participation/read state | Отвечает за участие/непрочитанное, не заменяет общий ACL. Assignee и разрешённые участники различаются. |
| OmniMessageLink | bindingId, providerChatId, nativeMessageId, messageId, providerRevision, origin, outgoingCommandId | DB UNIQUE(bindingId, providerChatId, nativeMessageId). Для исходящего до native ID существует Command, а не фиктивное подтверждённое сообщение. |
| OmniIncomingReceipt | bindingId, eventId, payloadHash, kind, origin, payload, state, attempts, error | UNIQUE(bindingId,eventId). Надёжный ACK после commit; исходный payload ограниченно хранится для replay/расследования. |
| OmniAutomationAdmission | bindingId, nativeMessageKey, effectKind, activationVersion, trustedSourcePosition, eventId | UNIQUE(bindingId,nativeMessageKey,effectKind,activationVersion). Допуск live-эффекта отдельно от дедупликации текста; атомарно с DomainEvent/outbox. Origin первого insert не решает, нужен ли live-ответ. |
| OmniOutgoingCommand | commandId, conversationId, actor, idempotencyKey, payloadHash, payload/files, expectedEpoch, policyVersion, state, connectorJobId, error | UNIQUE(workspaceId,actor,idempotencyKey) с проверкой целевого conversation и payload. Повтор не меняет адресата. |
| OmniDomainEvent / ConsumerReceipt | eventId, type, conversationId, origin, causationId, revision; consumerId | Публикация после commit; UNIQUE(consumerId,eventId) для приёма. Выполнение внешнего действия дополнительно идемпотентно. |
| OmniInternalNote | conversationId, authorWorkspaceMemberId, body, timestamps | Не является Message для отправки; отдельная операция/права. |
| OmniAttachmentLink | Message или Command, fileId, providerAttachmentId, state, original metadata | Проверка прав связанного объекта; не хранить внешний URL как постоянную доступную всем ссылку. |
| OmniImportBatch | bindingId, source, cursor, watermark, counts, incompleteReasons, state | Возобновление и сверка; не хранить пароль SaleBot в batch. |
| OmniRouteActivation | bindingId, activationVersion, activationBoundary, sourcePositionType | Зафиксированная граница исторических и новых событий. Меняется отдельной операцией с аудитом; не переактивирует прежнюю историю автоматически. |
| CrmAuditEntry | actor, initiatingActor, action, resource, outcome, safe diff, correlationId, timestamp | Общий аудит CRM и omnichannel в собственном `engine/core-modules/crm-audit`; прежнее проектное имя OmniAuditEntry заменено. Append-only контракт и собственный UI без подписки; [полная модель](08-audit.md). |

Физические таблицы, индексы, ORM metadata и FK выбираются в file-level плане после проверки workspace migration conventions. Таблица выше фиксирует доменные связи и уникальность; не утверждает существование FK между core и workspace schemas. Все ссылки на connection/member/person проверяются на тот же workspace, мягко удалённые записи обрабатываются явно.

## Состояния

- Conversation: `open/closed`; режим `human/assist/auto` отдельно от состояния. Теги и дополнительные статусы не обязательны до продуктового решения.
- Receipt: `accepted -> processing -> applied`; отдельно `retryable_error`, `quarantined`. Lease после сбоя освобождает обработку, а unique keys сохраняют идемпотентность.
- Outgoing: `pending -> dispatching -> accepted -> sent`; альтернативы `cancelled`, `failed`, `outcome_unknown`. Поздние receipts согласуются монотонно; старый timeout не переводит подтверждённое sent обратно в unknown. delivered/read — независимые подтверждённые метки.
- Attachment: `pending/ready/unavailable/rejected`; недоступный файл не маскируется как успешно перенесённый.
- Import: `planned/running/paused/completed/completed_with_gaps/failed`.

## Политика доступа: обязательная семантика

Проверяем action + principal + workspace + ресурс + текущие назначения/команду/явные grants + стадию сделки + доступ к подключённому аккаунту. Любое разрешение ограничено workspace; отсутствие правила не выдаёт доступ. Связь с разрешённым диалогом не открывает автоматически все сделки клиента.

| Субъект | Целевая возможность | Запрет |
|---|---|---|
| Менеджер | Назначенные/явно разрешённые диалоги и записи, совместные ответы | Чужие данные, изменение своей роли, произвольная смена маршрута |
| Руководитель | Разрешённая область команды, назначения | Другие команды без отдельного разрешения |
| Администратор workspace | Подключения и правила workspace | Автоматические права на другой workspace/сервер; чтение всех переписок требует явно выбранной роли |
| ИИ | Пересечение agent/application/caller прав и conversation policy | Расширение scope из текста клиента или tool arguments |
| Connector credential | События/receipts только привязанных аккаунтов | CRM search/export, управление ролями, произвольный workspace |

Выбрана собственная политика без подписки Twenty (D-18). Матрица выше — исходная архитектурная семантика, конкретный состав ролей и команды ещё согласуются. Visibility этапа, просмотр сделки, изменение полей, переход и редактирование воронки — отдельные actions; переход выполняется атомарно с проверкой правил и пересчётом видимости.

Клиентские файлы выдаются через endpoint с актуальной проверкой доступа к родительскому Message/Conversation. Не отдавать пользователю долгоживущий storage capability URL, позволяющий обойти последующий отзыв роли. Короткие внутренние transport grants ограничиваются файлом/командой/TTL; уже начатая передача имеет отдельную границу отмены. Физическое удаление, сроки хранения и политика аудита требуют выбранного retention.
