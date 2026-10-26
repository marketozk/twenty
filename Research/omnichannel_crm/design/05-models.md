# Модель данных и инварианты

Актуальные определения: [индекс владельцев](../plan/contracts/README.md). Этот документ описывает архитектуру/сценарии; точные контракты и schema находятся у указанных владельцев.

[Единый контракт автоматизации](09-automation-contract.md) определяет инструменты, stable workflow identity, pausing и общую квоту ответов. Текущий допуск и ограничения — [STATUS](../STATUS.md); проектируемые функции ещё не реализованы.

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

Полный состав entities, обязательных полей, FK/UNIQUE и индексов определён только в [спецификации §3](../plan/implementation-spec.md#3-схема--rob-764). Этот документ описывает ownership и границы данных, не отдельную схему.

Физическое хранение служебных сущностей выбрано в core той же БД, определения entities под engine/core-modules, без workspace objectMetadata/generated CRUD — [integration-map](../implementation/integration-map.md). Message/MessageThread остаются штатными workspace entities. Instance commands создают таблицы/составные индексы; динамические связи с workspace records проверяются сервером, FK между ними не объявляются существующими. Все ссылки на connection/member/person проверяются на тот же workspace, мягко удалённые записи обрабатываются явно.

## Состояния

Состояния Conversation и режимы: [права/управление](../plan/contracts/access-control.md#closed-status). Command: [отправка](../plan/contracts/sending-ui.md#command-states).

- Receipt: `accepted -> processing -> applied`; отдельно `retryable_error`, `blocked_config`, `quarantined`; recovery blocked_config — по spec §15.27. Lease после сбоя освобождает обработку, а unique keys сохраняют идемпотентность.
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

Merge Person/Company partition-ит omni-owned participants/target associations до generic relation migration; domain lifecycle adapter переносит их в общей transaction с suppression/audit и неизменяемым author snapshot. Email relations сохраняют штатный путь. Подробно spec §15.2/T23.

AttachmentLink переходит Command→Message атомарно с receipt/MessageLink/audit, сохраняя XOR и current ACL; echo/retry идемпотентны (spec §15.23).

## Канонические связи и инвентарь служебных сущностей

Определение: [implementation-spec — 7-права-и-сделки--rob-766](../plan/implementation-spec.md#7-права-и-сделки--rob-766).

Определение: [implementation-spec — 3-схема--rob-764](../plan/implementation-spec.md#3-схема--rob-764).

Определение: [sending-ui — fifo](../plan/contracts/sending-ui.md#fifo).
