# Этап 3. Собственные права и переходы сделок

Нормативные определения: [индекс владельцев](contracts/README.md). Этот документ содержит производные работы и проверочные сценарии; изменение семантики вносится у владельца и затем отражается в сценарии.

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Зависимости: 1 и аудит 2a. Статус: не выполнен. Без Enterprise key, без модификации коммерческой RLS реализации.

По [исходникам](../implementation/access-source.md) выбираем один общий `engine/core-modules/crm-access`, а conversation-access — адаптер. Основной hook WorkspaceRepository.onBeforeExecute плюс mutation kernels; raw queries имеют отдельный контролируемый purpose. Export получает own policy epoch; SSE — независимую admission; protected file download — актуальный ACL вместо одного file JWT. Точные файлы/методы и новые компоненты перечислены в отчёте и [карте](../implementation/integration-map.md); CommonBase не единственный барьер.

**Новые:** server `engine/core-modules/crm-access/{services/,query/,types/,entities/}` и `modules/omnichannel/access/conversation-access.service.ts`; policy/member/team/grant storage в core по integration-map. Общая CRM-политика не зависит от наличия conversation: сделка без чата также защищена. Один движок, conversation-access — адаптер.

**Существующие entry points:** `engine/api/common/common-query-runners/common-base-query-runner.service.ts`, `engine/twenty-orm/workspace-orm.manager.ts`, `engine/api/common/common-nested-relations-processor/process-nested-relations.helper.ts`, `engine/core-modules/record-export/`, `engine/subscriptions/`, `engine/core-modules/file/guards/file-by-id.guard.ts`, AI tool execution и workflow context. Точки общей политики и отдельные пути установлены в integration-map; изменения выполнять по ней, проверяя каждый затронутый контракт.

1. Зафиксировать fixture matrix manager A/B/lead/admin/AI/app, clients X/Y, shared thread, visible/hidden stages. Product role matrix ещё уточняется; fixtures не являются реальной настройкой сотрудников.
2. Объединить существующие object/field permissions с независимой запись-уровневой политикой. Scope применяется до DB read/filter/order/groupBy/count/export, не post-filter в UI. Не reuse Enterprise RLS predicates, не подменять entitlement. Для system bypass у существующих writers явный audit и узкий approved purpose.
3. CRUD, назначение/шаринг, доступ к файлам/подпискам, изменение прав и инвалидирование кеша/AI-контекста. Связь клиента с диалогом не открывает все сделки клиента.
4. Переходы stage: domain validation внутри mutation transaction, одинаковая для UI/generic API/AI/workflow; запрещённый переход отклоняется до изменения и фиксируется в audit. Default allow-all не вводится.
5. Закрыть прямое изменение route/controlEpoch/actor/system fields через generated API. File download с актуальными ACL; ранее выданные внешние capabilities отдельно ограничены.

**Verify:** negative tests для всех mapped entry points, 2 workspaces, shared/private conversation, orphan/deleted records, revoke during pagination/export/SSE/AI, hidden stage aggregate и field masking. Сначала минимальный query/predicate test, затем DB integration и UI. Audit отказа не раскрывает объект неавторизованному actor.

**Done when:** матрица запретов проходит на Free/self-hosted, включая прямой API; не осталось немаркированного system bypass. Можно безопасно проверять multi-manager UI.

**Rollback:** при выключении новой политики protected объекты недоступны, а не возвращаются к широким upstream grants. Не выкатывать fallback «разрешить всё» ради доступности.


Четвёртый раунд уточняет обязательные AutomationArtifactScope и own baseline readability (§15.12–15.13), policy reauthorization/lock modes (§15.15), core CrmRecordRevision для CAS сделки (§15.17). Эти механизмы входят в этап, до активации прав; production зависит от G18.

Обязателен §15.18: собственный admission обычных SSE/webhook/logic-function events; guard всех metadata usable account/channel/folder paths; feature inventory до удаления Enterprise функций и G18.

## Primary reads, links и ранняя проверка contention

Protected query context принудительно выбирает primary для policy и данных, включая caller useReplica:true, search/export/AI/raw readers. Смешанный запрос целиком primary; недоступность primary не вызывает replica fallback. T08/T10: stale replica после revoke не раскрывает данные; отрицательный контроль возвращает replica routing. Ordinary unprotected routing сохраняется. Проверенные точки: SearchService, WorkspaceDataExportPartWriterService, WorkspaceDataSourceService (см. source inventory).

ConversationTarget — canonical core edge; native MessageThreadTarget только projection для Person/Company/Opportunity, Task/custom — domain query. Реализовать link/unlink expectedTargetRevision с текущими ACL обеих сторон, policy UPDATE/epoch/audit; generic target mutations/rematch omni запрещены. T10/T13/T23 включают unlink/relink во время LLM, Task link, hidden target и rollback projection.

До массового подключения mutation/read kernels и UI выполнить micro-load T19 по policy row: долгие readers, concurrent stage/assignment/revoke, bounded timeout/deadlock metrics по G13. При непрохождении остановить расширение и отдельно пересмотреть протокол с revoke/atomicity доказательством. Не убирать fence и не вводить split epochs по умолчанию. Этап 7 повторяет системную нагрузку.

StageRule read/edit используют optionValue; transition — from/to; configure — wildcard. Полный UNIQUE с action/principal по §3. T30 проверяет оба вида без NULL/wildcard двусмысленности.

Native role/permission inputs для protected context читать через primary executor внутри policy fence, не из ранее загруженного WorkspaceCacheService map. T10/T31 проверяют stale role cache после revoke. Mode/status/close/takeover используют UPDATE policy lock; G20/takeover_on_send не делают SHARE→UPDATE upgrade (spec §15.26).
