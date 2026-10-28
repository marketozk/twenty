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

Первый срез ROB-765 реализован в [LOG089](../implementation/log089/README.md): внутренний `nativeAudit` owner для Company scalar update/updateMany, server-derived actor, row locks и точные snapshots независимо от emission flags; crmRecord — 24-й вид ресурса. Успех и audit атомарны, перехваченная ошибка mutation отравляет transaction. Повтор уже committed operationId отказывается до callback, это не command replay. Значения native полей редактируются полностью; NUMERIC сохраняет точность при сравнении.

**Остаётся до Done:** остальные native entry points и общий CRM CRUD/merge/bulk, metadata/role/session owners, отрицательные события после подтверждённого rollback, health/alert, доказательства API/AI/workflow. Файловый executor для updates реализован LOG092/093; public UPDATE owner — LOG094. Индекс audit(workspaceId, operationId) подготовлен и проверен в [LOG090](../implementation/log090/README.md), десятая fork migration; при выкате writers должны быть остановлены на время построения. Неподключённые writers не объявляются аудированными. Просмотр/экспорт — ROB767 после ROB766. [Текущая приёмка ROB765](../implementation/rob765-progress.md).


[LOG091](../implementation/log091/README.md) расширяет внутренний opt-in на non-file
updates Company/Person/Opportunity, включая composite/JSON/arrays/Date/resolved FK.
606 tests/24 suites и26 guards PASS;27 новых PG cases. Snapshot-before-coverage
закрывает mutable input/accessor bypass. В этом срезе FILES были отказаны; public writers
не подключены. Общие критерии Done не выполнены.


[LOG092](../implementation/log092/README.md) добавляет same-executor FilesFieldSync,
actual parent/File postconditions и25-й ресурс crmFile с exact parent scope.
642 tests/25 suites,36 новых PG cases и26 guards PASS. Ordinary path ещё не подключён;
public input parity для FILES null и OPEN system timestamps выполнен LOG093.
Подробные критерии и остаток — [приёмка ROB765](../implementation/rob765-progress.md).


[LOG093](../implementation/log093/README.md): существующие OPEN system timestamp writes
аудируются без implicit updatedAt шума; FILES null сохраняет native-only clear без
core cleanup.660 tests/25 suites,18 новых PG cases,26 guards PASS. Automatic
REST/GraphQL UPDATE owner, proven inherited scope и scoped nested reads/hooks реализованы LOG094.

[LOG094](../implementation/log094/README.md): Common UPDATE_ONE/UPDATE_MANY стандартных
Company/Person/Opportunity автоматически получают strict audit transaction. Nested
reads и mutation используют один executor; inherited scope требует identity proof,
актуального lifecycle, workspace и actor. Root getters/visibility/hooks остаются после
COMMIT с прежним awaited error contract. 685 tests/26 suites PASS, 25 новых PG cases,
26 guard tests PASS. HTTP/JWT и File URL signing не эмулируются этой fixture.
Следом native CREATE kernel; public CREATE/upsert/shareWith/nested custom objects
требуют сохранения их контрактов до автоматического включения. ROB765 In Progress.

[LOG095](../implementation/log095/README.md): внутренний CREATE kernel для standard
Company/Person/Opportunity без вложений. Actual INSERT IDs и DB after snapshots,
mixed save/upsert в том же owner, capture inputs до lookup, отдельные create/update
action events. 716 tests/27 suites PASS, 31 новый PG case, 26 guard tests PASS.
В LOG095 FILES arrays были отказаны; LOG096 добавляет same-executor File sync,
actual-created parent mapping и неизменность skipped File rows. Все FILES поля
проверяются после writes, trigger/default mismatch откатывает транзакцию.
Public CREATE ещё не включён; далее nested/shareWith/upsert compatibility.

[LOG096](../implementation/log096/README.md): CREATE FILES и actual-written parents,
полный skipped File readback, shared-file concurrency, mixed save/upsert и unknown
COMMIT. 744 tests/27 suites PASS, 28 новых PG cases, 26 guards; 334/334 type roots,
189/189 baseline diagnostics и 0 новых. Публичные CREATE и собственный shared access
не объявляются готовыми; ROB765 In Progress.

[LOG097](../implementation/log097/README.md): внутренние create/update local
non-standard application objects. Metadata authority и canonical table identity,
исключение system/remote/чужих standard IDs; custom FILES и реальная вложенная цепочка
в одном explicit scope. 766 tests/28 suites PASS, 22 новых PG cases; 26 guards,
0 новых diagnostics. Public selector остаётся прежним. Далее soft-delete/restore;
CREATE/shareWith, физический delete/merge и прочие owners ещё не закрыты.

LOG098: native soft-delete/restore покрытых standard/custom records и автоматические
public DELETE_ONE/MANY, RESTORE_ONE/MANY Company/Person/Opportunity. Actual IDs,
scoped nested reads, deletedAt postconditions и audit используют один executor.
Matched restore/агрегация сохраняют success с пустым diff; hard-delete не включён.
792 tests/29 suites PASS, 26 новых PG cases, 140 targeted; 26 guards, 10 unchanged
migration checksums. Types 336/337 roots, 189/189 diagnostics, 0 новых/changed.
11 source hashes проверены. Демо не менялось, GitHub Actions не используется.
[Доказательства LOG098](../implementation/log098/README.md). Core user-session CREATE выполнен LOG099; revoke/logout выполнен LOG100;
public CREATE/shared access, physical delete/merge, остальные owners и negative audit открыты.

LOG099 подключает реальное создание workspace user-session к strict core owner:
session INSERT, actual readback и audit в одной транзакции; cookie после COMMIT.
coreUser actor и отдельный impersonation initiator определяются по серверным данным.
Workspace-agnostic session, logout/revoke и appToken пока отдельные открытые owners.
Postflush credential/lifecycle проверка и различимый committed post-hook error
не позволяют принять неизвестный исход за rollback. [Доказательства](../implementation/log099/README.md).

820 tests/30 suites PASS, 28 новых PG cases; 26 guards, 10 unchanged migration checksums. Types 338/340 roots, 189/189 baseline diagnostics, 0 новых/changed. 5 source hashes совпадают.

LOG100: single/bulk UserSession revoke использует strict core owner и audit SAVEPOINT
после actual UPDATE. Отказ журнала не отменяет отзыв, но явно сигнализируется.
Cache-hit перепроверяет DB revocation, поэтому failed Redis eviction не возвращает
доступ. Current actor/impersonation initiator, exact actual rows, preserved filters и
полная проверка остальных session fields покрываются PostgreSQL tests.
Workspace-agnostic revoke сохраняется без выдуманного audit tenant; appToken и
concurrent sign-in fencing пока открыты. [Доказательства](../implementation/log100/README.md).

835 tests/30 suites PASS, 15 новых PG cases, 43 targeted. 26 guards PASS, 10 migration checksums неизменны. Types: все изменённые server roots включены явно, 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed. 4 source hashes совпадают.

LOG101: обычные public CREATE_ONE/MANY для Company/Person/Opportunity и local custom
objects получают strict native owner. Admission использует snapshot после pre-hook;
настоящие share writes, upsert и nested CREATE пока остаются в прежнем root path.
PRIVATE/INHERITED с пустыми shares не считаются no-share. Strict inherited scope
требует proof, legacy inherited path сохраняется. FILES и postcommit hooks используют
существующие механизмы. Полного HTTP/JWT покрытия и выката нет. [Доказательства](../implementation/log101/README.md).

854 tests/30 suites PASS (169.5s), 19 новых PG cases, 58 targeted. 26 guard tests PASS; 10 migration checksums неизменны. Types 343/343 roots, 189/189 baseline diagnostics, 0 новых и 0 в изменённых строках. Существующая Brackets type diagnostic в неизменённом методе сохранена. 4 source hashes совпадают.

LOG102: flat public upsert включён в native audit owner для covered local объектов.
Mixed update/insert, unique match/restore, FILES и audit теперь атомарны. Сохраняются
normalization, createdBy, permissions и response contract. Concurrent absent key
может дать PostgreSQL23505 с rollback, без retry; unknown COMMIT не повторяется.
Nested CREATE/real shares пока вне root admission. ROB765 In Progress. [Доказательства](../implementation/log102/README.md).

871 tests/30 suites PASS (171.954s), 17 новых PG cases, 75 targeted. 26 guards PASS; 10 migration checksums неизменны. Types 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed-code. Прежняя Brackets diagnostic в неизменённом методе остаётся. 2 source hashes совпадают.

LOG103: public UPDATE_ONE/MANY, soft-delete/restore One/Many для covered custom
objects подключены к тому же strict native audit owner. Standard selector сохранён
через OR, permissions и relation behavior не расширены. Actual mutations, FILES,
audit и scoped reads атомарны; hooks после confirmed COMMIT. ROB765 In Progress. [Доказательства](../implementation/log103/README.md).

888 tests/30 suites PASS (174.467s), 17 новых PG cases; targeted193 tests/4 suites PASS. 26 guards PASS, 10 migration checksums неизменны. Types 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed-code. 3 local/remote source hashes совпадают.
