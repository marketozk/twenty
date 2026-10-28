# Этап 2. Аудит действий — обязательный

Нормативные определения: [индекс владельцев](contracts/README.md). Этот документ содержит производные работы и проверочные сценарии; изменение семантики вносится у владельца и затем отражается в сценарии.

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Спецификация: [design/08-audit.md](../design/08-audit.md). Статус: ROB-765 In Progress, реализация начата после подтверждённой приёмки ROB-764 (LOG088). ROB-767 остаётся Backlog. 2a зависит от 1; 2b зависит от собственной политики этапа 3. Остальные этапы дополняют аудит своими событиями.

Основа уже реализована в ROB-764 / LOG-022: CrmAuditEntry, транзакционный context,
append-only writer, безопасный diff и проверка DB privileges. Текущий каталог охватывает 23 вида ресурсов; собственные omni operations, native Message
composition, receipts/outbox/revisions используют общий atomic audit context (LOG028–087).
ROB-765 расширяет этот механизм на CRM/ORM/merge/bulk/session/metadata; ROB-767
добавляет просмотр и экспорт после собственных прав. ROB-765 начат; ROB-767 остаётся Backlog до собственных прав.
[Результат и границы LOG-022](../implementation/log022/README.md).

## Файлы

Существующая основа: server `engine/core-modules/crm-audit/{crm-audit-transaction-context.ts,append-crm-audit-entry.ts,crm-audit-canonical-json.ts,crm-audit.types.ts,verify-crm-audit-privileges.ts,entities/crm-audit-entry.entity.ts}`.
Audit entity размещена в отдельной schema `crm_audit` той же БД; она не является
workspace CRUD object. Второй writer/redaction protocol не создаётся.

Предстоящие файлы: адаптеры transaction scope и расширение каталога в том же
модуле, query service/resolvers; front `src/modules/crm-audit/{pages/,components/,hooks/}`.
Общие типы выносятся в `twenty-shared` по необходимости потребителей.
Дополнительные индексы workspace/time/actor/entity/correlation — через fork migrations.

Опоры для интеграции: `engine/twenty-orm/workspace-orm.manager.ts`, `engine/api/common/common-query-runners/common-base-query-runner.service.ts`, `engine/core-modules/user-session/`, `engine/metadata-modules/role/`, workflow builder/executor, own access service. Полный перечень writers берётся из integration-map. Existing `event-logs/event-logs.service.ts` — Enterprise, его не подключаем и не переписываем license gate. EventEmitter2 не обеспечивает надёжность записи.

## 2a. Сбор и достоверность

Точные стыки — [integration-map](../implementation/integration-map.md) и [source audit](../implementation/transactions-audit-source.md). Audit entity в `crm_audit`; workspace writes должны использовать тот же pg executor через scope.executeRawQuery. Адаптер к workspace scope уже реализован в LOG028 и используется omni writers; автоматическое покрытие общих native ORM mutations ещё предстоит. Metadata/roles — QueryRunner migration runner до commit; session create/revoke — core transaction owner. FilesFieldSync нельзя объявить частью workspace commit, пока отдельный core repository не заменён передачей executor. Не использовать afterCommit/EventEmitter как долговечный writer.

- Writer принимает server-derived actor/context и transaction scope. Успешные mutations пишут audit в том же commit; при невозможности аудита критичная операция не подтверждается.
- Для session/core/metadata операций отдельно использовать их transaction owner; интерфейс writer не должен обещать атомарность через две connections. Отказ фиксировать после rollback, не терять событие вместе с отменённой mutation.
- Allowlist полей diff, redaction секретов/личных текстов/signed URLs; actor user/AI/workflow/import/API, initiating actor, outcome, reasonCode, IDs и policyVersion. Тексты чатов и prompts не дублируются в журнале.
- Lifecycle отправки/AI/workflow как связанные события, не один «успешно» в момент постановки. Provider outcome не откатывается из-за сбоя audit: retry только persistence receipt, не повтор внешней отправки.
- Append-only API и DB grants; migration/retention role отдельно. Не обещать криптографическую неизменность от superuser. Обязательный alert о недоступности; logout/revoke не удерживать ради журнала.

**Verify 2a:** отказ writer откатывает изменение; повтор даёт один success; rolled-back mutation не выглядит успешной; событие denial отдельно; secrets absent; crash после provider send не повторяет send; инициатор не подменяется browser payload.

ROB-764 уже вводит минимальный audit transaction context для omni-мутаций. ROB-765 распространяет его на native ORM/merge/bulk. Единый flush до COMMIT по spec §15.27: повторное изменение строки одним action внутри merge/bulk агрегируется first-before/last-after, не конфликтует по eventKey и не переносится в afterCommit. T06 проверяет flush failure и реальный rollback.

## 2b. Просмотр и экспорт

- Собственный экран «Аудит действий» и панель истории объекта: время/кто/что/источник/результат/безопасный diff/цепочка correlation.
- `audit.read/export/manageRetention`; фильтрация области и полей до выборки, count и экспорта. Исторический доступ не оставляет бессрочного права после увольнения/передачи клиента; deleted entities используют текущую административную политику и сохранённый security descriptor.
- Срок хранения и backup ещё выбираются; до решения не запускать автоматическую очистку. Экспорт и retention jobs сами аудируются без рекурсии.

**Verify 2b:** менеджер не видит чужой объект/имя/значение/count через audit query/export; revoke работает; application role не update/delete журнал; restore сохраняет связи событий; UI и API показывают одинаковый разрешённый набор.

**Done when:** карточка, сообщение, роль и workflow из тестовых сценариев имеют доказуемую цепочку автора и результата; журнал доступен без Enterprise key.

**Rollback:** отключение UI не отключает сбор; исправление событий добавлением нового correction-event, не редактированием истории. Для schema rollback сначала резервная копия и проверка потери полей/событий.

LOG087 adds bounded parent delete audit and retained current-administrative deletedParent scope, including multi-binding manifest hash. Native/custom FK effects without an audited writer refuse the operation. ROB765 must preserve this contract while broadening native ORM/lifecycle coverage; new destroy is not proof that generic native audit is complete.

Первый срез ROB-765: обычные Company scalar update/updateMany через текущие native kernels, один strict transaction-owned audit context и фактические row snapshots независимо от emission flags. Предварительно подтверждены: no-validation Company update может идти без transaction; FilesFieldSync использует отдельный core pool. Поэтому файловая атомарность и полный native audit ещё не заявляются.
