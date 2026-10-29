# Этап 2. Аудит действий — обязательный

Нормативные определения: [индекс владельцев](contracts/README.md). Этот документ содержит производные работы и проверочные сценарии; изменение семантики вносится у владельца и затем отражается в сценарии.

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Спецификация: [design/08-audit.md](../design/08-audit.md). Статус: ROB-765 In Progress, реализация начата после подтверждённой приёмки ROB-764 (LOG088). ROB-767 остаётся Backlog. 2a зависит от 1; 2b зависит от собственной политики этапа 3. Остальные этапы дополняют аудит своими событиями.

Основа уже реализована в ROB-764 / LOG-022: CrmAuditEntry, транзакционный context,
append-only writer, безопасный diff и проверка DB privileges. Каталог до начала ROB-765 охватывал 23 вида ресурсов; собственные omni operations, native Message
composition, receipts/outbox/revisions используют общий atomic audit context (LOG028–087).
ROB-765 расширяет этот механизм на CRM/ORM/merge/bulk/session/metadata; ROB-767
добавляет просмотр и экспорт после собственных прав. ROB-765 начат; ROB-767 остаётся Backlog до собственных прав.
[Результат и границы LOG-022](../implementation/log022/README.md).

## Файлы

Существующая основа: server `engine/core-modules/crm-audit/{crm-audit-transaction-context.ts,append-crm-audit-entry.ts,crm-audit-canonical-json.ts,crm-audit.types.ts,verify-crm-audit-privileges.ts,entities/crm-audit-entry.entity.ts}`.
Audit entity размещена в отдельной schema `crm_audit` той же БД; она не является
workspace CRUD object. Второй writer/redaction protocol не создаётся.

Native/core adapters и каталог частично реализованы в том же модуле. Предстоят остальные owners,
query service/resolvers; front `src/modules/crm-audit/{pages/,components/,hooks/}`.
Общие типы выносятся в `twenty-shared` по необходимости потребителей.
Дополнительные индексы workspace/time/actor/entity/correlation — через fork migrations.

Опоры для интеграции: `engine/twenty-orm/workspace-orm.manager.ts`, `engine/api/common/common-query-runners/common-base-query-runner.service.ts`, `engine/core-modules/user-session/`, `engine/metadata-modules/role/`, workflow builder/executor, own access service. Полный перечень writers берётся из integration-map. Existing `event-logs/event-logs.service.ts` — Enterprise, его не подключаем и не переписываем license gate. EventEmitter2 не обеспечивает надёжность записи.

## 2a. Сбор и достоверность

Точные стыки — [integration-map](../implementation/integration-map.md) и [source audit](../implementation/transactions-audit-source.md). Audit entity в `crm_audit`; workspace writes должны использовать тот же pg executor через scope.executeRawQuery. Адаптер к workspace scope уже реализован в LOG028 и используется omni writers; автоматическое native покрытие частично реализовано; точный остаток — в таблице приёмки ниже. Metadata/roles — QueryRunner migration runner до commit; session create/revoke — core transaction owner. FilesFieldSync для covered native CREATE/UPDATE использует тот же executor (LOG092/096); это не покрывает последующее физическое удаление файлов. Не использовать afterCommit/EventEmitter как долговечный writer.

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

## Актуальное покрытие и оставшиеся критерии

ROB765 остаётся In Progress. Единственная текущая таблица приёмки —
[rob765-progress](../implementation/rob765-progress.md). История результатов и
ограничений каждого среза сохранена в [DEVLOG](../DEVLOG.md), а не дублируется здесь.

| Реализованный участок | Доказательства |
|---|---|
| Native owner, actor, snapshots, precision, rollback/unknown и operation reuse | [LOG089](../implementation/log089/README.md) |
| Индекс операций, migration10 и populated upgrade/replay/down | [LOG090](../implementation/log090/README.md) |
| Standard updates, FILES same-executor и public input parity | [LOG091](../implementation/log091/README.md), [LOG092](../implementation/log092/README.md), [LOG093](../implementation/log093/README.md) |
| Public UPDATE, native CREATE/FILES и local custom metadata | [LOG094](../implementation/log094/README.md), [LOG095](../implementation/log095/README.md), [LOG096](../implementation/log096/README.md), [LOG097](../implementation/log097/README.md) |
| Soft-delete/restore | [LOG098](../implementation/log098/README.md) |
| Workspace user-session CREATE и revoke/cache check | [LOG099](../implementation/log099/README.md), [LOG100](../implementation/log100/README.md) |
| Public CREATE/upsert, custom UPDATE/lifecycle, bounded nested CREATE | [LOG101](../implementation/log101/README.md), [LOG102](../implementation/log102/README.md), [LOG103](../implementation/log103/README.md), [LOG104](../implementation/log104/README.md) |
| Internal hard-delete и direct covered SET_NULL; retained guards, actual effects | [LOG105](../implementation/log105/README.md), [LOG106](../implementation/log106/README.md) |
| Guard неаудированных ON UPDATE effects: composite keys, timestamps, BEFORE triggers | [LOG107](../implementation/log107/README.md) |
| Direct covered ON DELETE CASCADE с retained child guards и actual-effects audit | [LOG108](../implementation/log108/README.md) |
| Refresh signOut: immediate security revoke, auth fence и security-first audit | [LOG109](../implementation/log109/README.md) |
| Workspace refresh issuance/rotation: strict owner, actual snapshots, common operation | [LOG110](../implementation/log110/README.md) |
| Public/AI role CREATE/UPDATE: metadata owner, actual snapshots, conservative cache invalidation | [LOG111](../implementation/log111/README.md), [LOG112](../implementation/log112/README.md) |
| Public member role assignment, serialized demotions, fresh application tenant checks | [LOG113](../implementation/log113/README.md) |
| Core membership cleanup: shared fence, atomic deletion, durable workflow-share recovery prerequisite | [LOG114](../implementation/log114/README.md) |
| Explicit-operation membership audit primitive: fixed FK effects, recursive navigation, security-first savepoint | [LOG115](../implementation/log115/README.md) |
| Fresh active membership check for JWT/cookie and delegated application despite stale caches | [LOG116](../implementation/log116/README.md) |

Открыто: остальные native/system writers и FK effects, real share writes, public
DESTROY/MERGE, остальные metadata/role mutations, общий denied/failed audit после rollback и health/alert.
LOG109 покрывает signOut предъявленного refresh token; LOG110 — workspace выпуск/rotation. Family revoke,
stateless application JWT и concurrent-sign-in fencing ещё не объявлены покрытыми.
Просмотр/экспорт — ROB767 после ROB766; AI/workflow/connector добавляют свои события
в ROB768/769. Полный HTTP/JWT и сборка/выкат изменений после LOG088 не выполнялись.

Последние проверки: 1237 tests/39 suites PASS (203.9s); 182 targeted/5 suites и 29 auth unit tests PASS, 21 новый case. 26 guards PASS; 10 migration checksums неизменны. Types 354/355 roots, 190 baseline / 184 current диагностик, 0 новых/changed-file. 3 local/remote source hashes совпадают.
Full-server typecheck не чистый. [Проверки LOG116](../implementation/log116/results.json).

Следующий шаг — автоматическая trusted attribution из API/jobs и exact retained
membership cleanup при hard teardown; [граница](../implementation/log116/next-boundary.md).
LOG116 закрывает cache gap fresh DB lookup; весь public removal, in-flight mutation
fence и полный HTTP отзыв ещё не приняты.

Демо остаётся прежним. При будущем выкате migration10 writers останавливаются на
время построения индекса. GitHub Actions не используется.
