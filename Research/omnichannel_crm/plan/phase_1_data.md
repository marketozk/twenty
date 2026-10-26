# Этап 1. Модель общения, inbox/outbox и журнал

Зависимость: этап 0. Статус: не выполнен.

**Новые:** server `modules/omnichannel/{omnichannel.module.ts,entities/,services/,jobs/,controllers/}`; shared `src/omnichannel/`; аудит `engine/core-modules/crm-audit/{crm-audit.module.ts,entities/,services/}`. Конкретная metadata registration и миграция — по integration-map этапа 0; upgrade-команды только в актуальной версии, timestamp новее существующих, с down согласно CLAUDE.md.

**Существующие:** server `engine/metadata-modules/message-channel/services/application-message-ingestion.service.ts`; `modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts`, `messaging-message.service.ts`; `engine/workspace-event-emitter/workspace-event-emitter.ts`; `engine/twenty-orm/types/workspace-transaction-scope.type.ts`.

## Порции реализации

1. Entities/indexes: AccountBinding, ExternalIdentity, Conversation, Member, MessageLink, Receipt, Command, DomainEvent, ConsumerReceipt; отдельная audit entity. Ограничения уникальности из design, миграции apply/rollback на пустой и заполненной тестовой БД.
2. Сохранение ingress: узкие credentials, schema validation, durable receipt/ACK, проверка generation; eventId+payload конфликт вместо overwrite. Из raw события нельзя назначить actor/право/import-origin.
3. Общая транзакционная часть messaging persistence: Message+participants+link+revision+DomainEvent+audit атомарно. Email pipeline использует прежнее поведение; добавить email-regression. DB constraints и блокировка не зависят только от cache lock TTL.
4. Outbox: state machine, lease/recovery, immutable commandId, optimistic revision. Worker checkpoint и enqueue recovery из PostgreSQL. Пустой Redis не означает потерю бизнес-команд.
5. Event consumer: стабильный execution ID, pending/running/completed, восстановление после claim; импортный origin переносится, публикация только после commit.
6. RouteActivation и AutomationAdmission: отдельная дедупликация бизнес-эффекта относительно доверенной границы активации. Сохранение текста import не занимает навсегда право на обработку нового live-события; admission/event/outbox атомарны. Полный контракт — design/02-behavior.md.

**Verify:** параллельные повторы/конфликт payload; fault injection перед каждым commit; DB unique keys; задержка дольше TTL; потеря Redis; late receipts; один audit success на одну committed mutation. Все на PostgreSQL, а не только mock.

**Done when:** один синтетический входящий виден в штатном Message и связан с Person; любой crash даёт либо полный commit, либо безопасный replay; нет открытого auto CRUD системных полей.

**Rollback:** выключить только omni consumers; сохранить receipts/outbox для replay. Откат схемы с реальными сообщениями не делать вслепую; сначала восстановленный тестовый backup.
