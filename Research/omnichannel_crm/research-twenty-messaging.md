# Исследование Twenty: сообщения, интерфейс и SDK

Статус документа: датированное исследование закреплённых исходников; описания тогдашней среды и «следующих шагов» ниже исторические. Текущие результаты обновления, состояние плана и порядок работы — [STATUS.md](STATUS.md). Нормативные решения по автоматизации — [design/09](design/09-automation-contract.md); runtime этой доработки ещё не написан.

Дата: 26.10.2026. Исследован локальный форк `marketozk/twenty`, HEAD `2ee4d65aa34ba3ae6b0f561ed7051df51cadc0d8`; исходный upstream `729f6236126eddaa68d176fb766bc349b19de11d`. Изменения приложения, установка зависимостей, запуск тестов и обращения к живым клиентам не выполнялись. Это исследование исходников, не подтверждение наличия всех функций в установленном демо.

## Главный результат

В коде есть **две разные модели переписки**. `Message/MessageThread` обслуживает email pipeline и отдельный APP API приёма внешних сообщений; исходящая доставка пока поддерживает только почтовые драйверы. В `engine/metadata-modules/ai` существует внутренний Inbox с совместными диалогами сотрудников и ИИ, назначением, непрочитанным, каналами и подписками. Ни одна из проверенных цепочек не является готовым транспортом Telegram/MAX.

Уточнение 26.10.2026: первоначальное исследование проследило email import/outbound и пропустило APP ingestion. После сравнения 2.51→2.52 это исправлено; см. раздел ниже и [принятую базу](reuse-2.52.md). Готовая основа внешнего текстового импорта уже есть в 2.51, полный операторский чат поверх неё ещё не подключён.

У внутреннего Inbox есть полезные уже реализованные механизмы для R-02/R-09: авторство менеджера, участники, общий диалог, назначение, связь с CRM, история, права и обновления экрана. Однако внешняя идентичность клиента, адрес доставки, состояния отправки мессенджера, импорт старой переписки и разделение внутреннего/внешнего сообщения требуют отдельного контракта. Прямо выдавать внешнего клиента за сотрудника или сообщение клиента за ответ ИИ текущая модель не обосновывает.

## Проверенные файлы и контракты

Пути ниже — относительно корня Twenty, номера строк соответствуют исследованной ревизии.

| Область | Файл / символ | Подтверждённое назначение |
|---|---|---|
| Почтовое сообщение | `packages/twenty-server/src/modules/messaging/common/standard-objects/message.workspace-entity.ts:9` — `MessageWorkspaceEntity` | `headerMessageId`, тема, текст, дата получения, поток, участники, связи каналов, `isDraft` |
| Почтовый поток | `.../messaging/common/standard-objects/message-thread.workspace-entity.ts:6` | Тема, сообщения, `messageThreadTargets` |
| Внешний ID почты | `.../messaging/common/standard-objects/message-channel-message-association.workspace-entity.ts:7` | Внешние ID сообщения/потока, направление, `messageChannelId`, папки |
| Участник почты | `.../messaging/common/standard-objects/message-participant.workspace-entity.ts:11` | Роль отправителя/получателя, handle, отображаемое имя, связь person/workspaceMember |
| Связи почты и CRM | `.../messaging/common/standard-objects/message-thread-target.workspace-entity.ts:8` | Контакт, компания, сделка; автоматическое/ручное назначение |
| Импорт почты | `.../messaging/message-import-manager/services/messaging-get-messages.service.ts:27` — `getMessages` | Драйверы Google, Microsoft, IMAP; остальные провайдеры отклоняются |
| Сохранение почты | `.../messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts:53` | Транзакция сообщений, участников и связей, затем очередь создания контактов; фильтры и идентификация основаны на email |
| Дедупликация почты | `.../messaging/message-import-manager/services/messaging-message.service.ts:46` — `saveMessagesWithinTransaction` | Поиск по `headerMessageId` и внешнему ID потока, построение существующих/новых сообщений и ассоциаций; это не универсальный ключ `(platform, account, chat, message)` |
| Отправка почты | `.../messaging/message-outbound-manager/services/messaging-message-outbound.service.ts:24` — `sendMessage` | Google, Microsoft, IMAP/SMTP, EmailGroup; `APP`, OIDC, SAML явно не поддерживают отправку |
| Контракт отправки | `.../messaging/message-outbound-manager/types/send-message-input.type.ts:3` | `subject`, `to`, `cc`, `bcc`, HTML/body, attachments, email threading headers |
| Скрытие текста почты | `.../messaging/common/query-hooks/message/apply-messages-visibility-restrictions.service.ts:27` | Ограничивает `subject`/`text` через политику видимости messageChannel и владельца connectedAccount; отдельный механизм от доступа к клиентским диалогам |
| Внутренний диалог | `packages/twenty-server/src/engine/metadata-modules/ai/ai-history/standard-objects/agent-chat-thread.workspace-entity.ts:10` | Владелец, `assigneeId`, `channelId`, участники, CRM targets, вложения, последнее сообщение, архив/отложить, текущий stream и pending question |
| Сотрудник в диалоге | `.../ai/ai-history/standard-objects/agent-chat-thread-participant.workspace-entity.ts:6` | `workspaceMemberId`, `lastReadAt`, archived/snoozed, подписка, упоминания |
| Автор сообщения | `.../ai/ai-history/standard-objects/agent-message.workspace-entity.ts:11` | `senderWorkspaceMemberId`, `senderApplicationId`, `agentId`, role/status, turn/parts/reactions |
| Текстовые роли и статусы | `.../ai/ai-history/enums/agent-message-role.enum.ts:1`; `agent-message-status.enum.ts:1` | Роли `system/user/assistant`; статусы `queued/sent`. Здесь `sent` не означает доставку в Telegram/MAX |
| Совместный доступ | `.../ai/ai-chat/services/agent-chat-sharing.service.ts:86` — `getReadableThread`, `getThreadWithAccess`, `shareThreadWithMembers` | Проверка операций через workspace authorization/record sharing; создание диалога и выдача доступа участникам |
| Входящее сообщение приложения | `.../ai/ai-chat/resolvers/agent-inbox.resolver.ts:27`; `services/agent-inbox.service.ts:69` | `sendInboxMessage` доступен application principal с AI permission; адресаты — сотрудники, а не Telegram/MAX-чаты |
| Сообщение менеджера | `.../ai/ai-chat/resolvers/agent-chat.resolver.ts:197` — `sendChatMessage` | Контекст авторизованного сотрудника, текст, ID сообщения, файлы, упоминания, возможность `shouldAssistantReply` |
| Обновления | `.../ai/ai-chat/resolvers/agent-chat-subscription.resolver.ts:64`; `services/agent-chat-event-publisher.service.ts:29` | Подписка на диалог, перепроверка прав, Redis pub/sub, буфер частей ответа ИИ |
| Экран Inbox | `packages/twenty-front/src/modules/ai/components/AiChatInboxThreadList.tsx:23`; `hooks/useAgentChatInboxShownThreads.ts:11` | Списки/выбор/контекстное меню, фильтрация по каналу и представлению |
| Клиентская подписка | `packages/twenty-front/src/modules/ai/hooks/useAgentChatSubscription.ts:57,370` | Использует общий SSE client, обработку событий, восстановление и обновление прав |
| Вложения CRM | `packages/twenty-server/src/modules/attachment/standard-objects/attachment.workspace-entity.ts:17` | FILES field, author/createdBy/updatedBy и связи со стандартными/custom объектами, включая agentChatThread |
| Выдача файла | `packages/twenty-server/src/engine/core-modules/file/guards/file-by-id.guard.ts:40` | Проверяет подписанный file token, workspace/file ID и доступность workspace; это не повторная проверка текущих прав менеджера при каждом GET |

Сокращение `.../messaging` в таблице означает `packages/twenty-server/src/modules/messaging`, `.../ai` — `packages/twenty-server/src/engine/metadata-modules/ai`.

## Критические цепочки

### Почта

`ConnectedAccount` → поддерживаемый email driver → `MessagingGetMessagesService` → `MessagingSaveMessagesAndEnqueueContactCreationService` → транзакция `message/messageThread/association/participant` → очередь создания CRM-контактов. Обратное направление использует почтовый `SendMessageInput` и конкретный outbound driver.

Это существующий email-путь. Для внешнего приёма не нужно превращать Telegram/MAX в email driver: есть отдельная точка входа APP, которая использует то же транзакционное сохранение.

### APP-каналы и приём внешней истории

`packages/twenty-server/src/engine/metadata-modules/message-channel/services/application-message-channels.service.ts` проверяет владение/доступ к каналу. Соседний `application-message-ingestion.service.ts::ingest` проверяет sync, одного отправителя, уникальность externalId внутри пакета и существование ссылок Person/WorkspaceMember, затем под блокировкой канала вызывает сохранение сообщений. `toMessageWithParticipants` сохраняет исходные дату и ID, но задаёт `attachments: []`.

SDK `createMessageChannel`/`ingestMessages` и [документация](../../packages/twenty-docs/developers/extend/apps/logic/messaging-channels.mdx) уже есть в 2.51; их diff с принятым снимком 2.52 пуст. Пакет ограничен 100 сообщениями. Дедупликация — внутри канала, text повторным ingest не меняется; поздняя привязка участника поддержана, сброс identity через null — нет. Person link строит CRM targets, workspaceMember link отвечает только за авторство. APP-каналы не создают контакты автоматически и не отправляют ответы провайдеру.

Это готовая основа хранения текста и backfill, но не готовый импорт наших архивов: нужны преобразование источников, составные ID при локальной уникальности, checkpoints, файлы, обработка edit/delete и исключение автоответов/бизнес-процессов на истории. `bc3096f1` в 2.52 сохраняет APP identity links при изменении email клиента. Проверочная опора — `app-message-channels.integration-spec.ts` и `person-participant-rematch.integration-spec.ts`.

### Общий внутренний диалог

Авторизованный сотрудник → `sendChatMessage` → создание отсутствующего потока → `getWritableThread` → сохранение сообщения без ответа либо запуск ИИ → публикация события → SSE клиент → обновление истории/списка. Авторство привязано к `workspaceMemberId`, не к общему логину. Упомянутые сотрудники добавляются после отправки.

В `agent-chat.resolver.ts:285` отключение ответа ассистента допускается при `IS_AI_CHAT_INBOX_ENABLED`. Если флаг выключен, `shouldAssistantReply: false` не отключает ИИ: `isAssistantReplying = shouldAssistantReply || !featureFlag`. Поэтому «использовать внутренний чат только для людей» нельзя считать независимым от feature flag и версии. С включённым Inbox сохранение без ИИ не требует прохождения preflight запуска модели.

`AgentChatSubscriptionResolver` разрешает пользовательскую сессию и application/OAuth **с пользователем**, но не API key или application без пользователя; повторно проверяет читаемость диалога на heartbeat. `AgentChatEventPublisherService` сохраняет части активного стрима в Redis со сроком 3600 секунд и последовательными номерами. Основная история хранится в workspace entities PostgreSQL. Redis stream buffer не является архивом клиентских сообщений.

Доступ к каналу проверяется отдельно: `agent-chat-channel-access.service.ts:29–62` получает роль участника и применяет `isAgentChatChannelOpenToRole` (`utils/is-agent-chat-channel-open-to-role.util.ts:6–14`): `canAccessAllAgentChatChannels` либо роль в `channel.roleIds`. Для конкретного потока `AgentChatSharingService:150–209` добавляет редакторов через `RecordSharingService`, только когда вызывающий вправе управлять sharing, и возвращает лишь участников, действительно получивших `update`-доступ. `AgentChatThreadParticipantService:177–200` запрещает ответственному отписаться под блокировкой потока; назначение и подписка записываются совместно (`:230–233`). Это реальные основания для совместной работы, но не окончательная матрица доступа к клиентам и этапам: сочетание общих правил ролей и индивидуального sharing исследуется отдельно.

### Сообщение от приложения во внутренний Inbox

Application principal → `sendInboxMessage` → `AgentInboxService.sendMessage` → детерминированные ID из `senderKey/threadKey/idempotencyKey` → открытие/расшаривание потока указанным сотрудникам → транзакционная запись сообщения и частей → обновление активности.

`SendInboxMessageInputDTO` содержит `workspaceMemberIds`, `threadKey`, `idempotencyKey`, `title`, `text`, `toolCall`. Не содержит внешнего chat/account ID, исходного автора клиента, исходной даты, delivery receipt или списка вложений. Сообщение записывается с `role: ASSISTANT`, `senderApplicationId`; повтор не создаёт второе сообщение. Следовательно, это подходящий существующий механизм **служебного уведомления сотрудникам**, но не подтверждённый API полного импорта переписки клиента. Нельзя молча считать такую запись клиентским входящим сообщением.

## SDK и возможность интерфейса без широкого изменения ядра

Подтверждены следующие точки расширения:

- Front component в side panel, виджете dashboard/record page, app settings, inline результате AI tool. Источник: `packages/twenty-docs/developers/extend/apps/layout/front-components.mdx:7–29`.
- Sidebar item типа `PAGE_LAYOUT`, `OBJECT`, `VIEW`, `LINK`, `FOLDER`; standalone page layout можно наполнить front component. Тип `AGENT_CHAT_CHANNEL` присутствует для внутренних избранных, но **не поддерживается manifest API приложения**. Источник: `layout/navigation-menu-items.mdx:29–44`.
- Из компонента доступны CRM query/mutation через `CoreApiClient`, вызов собственных HTTP logic functions через `RestApiClient`, навигация/открытие карточки и панели ИИ. `packages/twenty-sdk/src/sdk/front-component/globals/frontComponentHostCommunicationApi.ts:18–187`.
- Logic function: HTTP, cron, database lifecycle event; функцию можно публиковать как AI tool и workflow action. Источник: `logic/logic-functions.mdx:55–61,629–679`. Это существующие точки для приёма события/инструмента, но контракт надёжной доставки ещё не задан.
- Файлы: `uploadFile(Blob, { fieldMetadataId })` использует FILES field; возвращает file ID/path/URL/size/MIME. Прогресс, отмена, проверка файла остаются ответственностью приложения. `front-components.mdx:672,1152–1156`.

У нас уже есть узкий локальный пример этой цепочки: `C:/Users/regis/OneDrive/Рабочий стол/Доделка робота 2/Research/twenty_demo/app/src/front-components/main-page.tsx:34,72`, `navigation-menu-items/main-page.navigation-menu-item.ts:12`, `page-layouts/main-page.page-layout.ts:15–32`: компонент читает/меняет CRM через SDK и размещается в standalone layout. Этот пример подтверждает форму исходников, но не готовность realtime chat, импорта, прав или мессенджерного транспорта.

### Ограничения, влияющие именно на экран чатов

1. **Это Remote DOM в sandbox/worker, а не обычный DOM браузера.** Сторонние компоненты могут молча зависеть от отсутствующих DOM API. `front-components.mdx:1050–1176` перечисляет ограничения измерения, скролла, событий, порталов, iframe, файлов, media. Для списка длинной истории, вложений/аудио и виртуализации нужен проверочный макет на выбранной версии.
2. **Realtime через штатный SDK не подтверждён.** `packages/twenty-client-sdk/src/generate/genql/runtime/createClient.ts:26–68` создаёт только `query`/`mutation`. `packages/twenty-client-sdk/src/generate/genql/render/client/renderClient.ts:144` содержит TODO возвращения subscription client. Host bridge не экспортирует метод subscription. Это не доказательство невозможности собственных соединений, но готового безопасного SDK-контракта в проверенной поверхности нет.
3. **Проксированный fetch не потоковый.** `packages/twenty-front-component-renderer/src/host/fetch/utils/serializeResponseToHostFetchResult.ts:12–37` читает `await response.text()` и сериализует полный body (лимит 50 MiB). Поэтому перенос внутреннего SSE hook в front component без адаптации не обоснован. Вне проксированных origins используется native fetch, но sandbox имеет `Origin: null` и отдельные требования CORS/авторизации. Нельзя выводить сервисный токен в UI ради такого обхода.
4. **Сеть и файловые API имеют разные пути.** На proxied fetch теряются AbortSignal и часть RequestInit; тело — string/URLSearchParams. Для файлов существует выделенный `uploadFile`. Источники: `front-components.mdx:1142–1156`, `.../remote/worker/fetch-proxy/utils/installHostFetchProxy.ts:7–35`.
5. CSS компонента внедряется в общий host head без автоматического namespace. Нужны собственные имена классов, иначе переоформление чатов заденет CRM. Это явно задокументировано в `front-components.mdx:1140`.

## Переиспользование и недостающие контракты по требованиям

| Требование | Есть в проверенном коде | Что ещё должно быть определено/проверено |
|---|---|---|
| F-01, R-03: каналы Telegram/MAX | Connections/apps, APP message channels, ingestMessages, HTTP functions | Транспорт/маршруты/account health/userbot auth, внешняя отправка и соединение APP-сообщений с операторским Inbox |
| F-02: рабочее место | Inbox list, shared threads, assignment, read/archive/snooze, UI message parts | Внешний клиент, платформенные delivery states, notes vs replies, служебные/внешние события, takeover и stale AI reply |
| F-03: карточки CRM | Person/company/opportunity, polymorphic target patterns, открытие side panel | Подтверждённая identity link между каналами; работа при скрытой связанной сущности |
| R-09: несколько менеджеров | Участники и авторство `senderWorkspaceMemberId`, sharing, права потоков | Автор CRM vs отправляющий userbot; одновременные ответы и присутствие коллег в клиентском диалоге |
| F-04/F-06: ИИ/workflow | AI conversation и tools; app notification; logic functions | Контекст именно клиента и разрешённых данных; внешняя отправка как инструмент; отмена устаревшего ответа |
| F-07/R-05: импорт | APP ingestion текста, исходных дат/авторов, person links и дедуп внутри канала | Преобразование архивов, вложения, edit/delete, checkpoints; отдельный режим импорта и запрет автоответов; границы истории/live |
| F-08: права | User-context guards, record sharing, periodic subscription auth | Один и тот же запрет в списке, тексте, related records, файлах, поиске/агрегациях; проверить на выбранном релизе |

## Файлы: отдельная граница доступа

CRM attachments и FILES field позволяют хранить файлы и связи с сущностями. Однако signed URL — самостоятельная возможность скачать файл: `FileByIdGuard` проверяет токен и file ID, не текущую роль сотрудника. Это не утверждение о найденной уязвимости. При проектировании нужно определить срок действительности уже выданного URL, поведение после отзыва доступа/перевода диалога, правила выдачи URL внешнему userbot и доступ к приватным вложениям. Тест «скрыли запись, но старый URL ещё работает» должен иметь заранее согласованный ожидаемый результат.

## Версии и проверки

- `packages/twenty-sdk/package.json:8` содержит `2.52.0`.
- `AgentChatChannelEntity` импортирует миграционную константу из `upgrade-version-command/2-51` (`packages/twenty-server/src/engine/metadata-modules/agent-chat-channel/entities/agent-chat-channel.entity.ts:13–24`). `AgentChatSharingService:62` отдельно поддерживает рабочие области до появления columns channels. Следовательно, даже текущий код учитывает неодинаковую готовность миграций.
- UI Inbox зависит от `IS_AI_CHAT_INBOX_ENABLED`; наличие файлов не означает включённый feature flag.
- Координатор исследования отдельно сверил live-контейнеры read-only через SSH: server/worker используют `twentycrm/twenty:v2.50.0`, PostgreSQL 16 и Redis 7.4. В этой части не проверялись flags/schema демо. Полная фиксация inventory — в основном `research.md`. Текущий код содержит `TWENTY_CURRENT_VERSION = 2.52.0` (`packages/twenty-server/src/engine/core-modules/upgrade/constants/twenty-current-version.constant.ts:11`). Приложение и SDK следует сравнивать с выбранным релизом, а не автоматически со свежим main.
- Ничего из перечисленного не запускалось в этой части исследования: выводы получены чтением исходников. Не утверждается прохождение unit/integration/UI тестов.

Релевантные существующие тестовые опоры:

- `packages/twenty-server/src/engine/metadata-modules/ai/ai-chat/services/__tests__/agent-inbox.service.open-thread.spec.ts` — внутренняя доставка/открытие потока.
- `packages/twenty-server/src/engine/metadata-modules/ai/ai-chat/utils/__tests__/build-inbox-message-ids.util.spec.ts` — стабильные ID сообщений.
- `packages/twenty-server/src/engine/metadata-modules/ai/ai-chat/utils/__tests__/acquire-agent-chat-channel-grant-locks-for-thread-write-or-throw.util.spec.ts` — согласование прав при записи.
- `packages/twenty-front/src/modules/ai/hooks/__tests__/useAgentChatSubscription.test.tsx` — клиентская подписка.
- `packages/twenty-front/src/modules/ai/components/__tests__/AiChatInboxThreadPagination.test.tsx`, `AiChatInboxSelectionEffect.test.tsx` — список/выбор.
- `packages/twenty-server/src/modules/messaging/message-outbound-manager/resolvers/__tests__/send-email.resolver.spec.ts`, `services/__tests__/sent-message-record-link.service.spec.ts` — email-контракт и связи CRM.

## Что это позволяет сравнить в Design

Фактов достаточно, чтобы сравнить: самостоятельный app-экран на custom objects/logic functions; адаптацию внутреннего Inbox в форке; комбинированное расширение с ограниченными изменениями host/core. Выбор здесь не сделан. Главные проверяемые различия: семантика клиентского автора и доставки, доступность Inbox на базовом релизе, разрешения, SSE/файлы в SDK, объём затронутого ядра и обновляемость. Существующая email-модель должна оцениваться по контрактам, а не только по названию `message`.
