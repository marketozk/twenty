# Этап 3. Собственные права и переходы сделок

Зависимости: 1 и аудит 2a. Статус: не выполнен. Без Enterprise key, без модификации коммерческой RLS реализации.

**Новые:** server `modules/omnichannel/access/{conversation-access.service.ts,crm-access-policy.service.ts,crm-scope-predicate.ts}`; policy/member/team/grant storage по модели. Общая CRM-политика не должна зависеть от наличия conversation: сделка без чата также защищена. При большой общности выделить один `engine/core-modules/crm-access/` после карты entry points, не создавать два движка.

**Существующие entry points:** `engine/api/common/common-query-runners/common-base-query-runner.service.ts`, `engine/twenty-orm/workspace-orm.manager.ts`, `engine/api/common/common-nested-relations-processor/process-nested-relations.helper.ts`, `engine/core-modules/record-export/`, `engine/subscriptions/`, `engine/core-modules/file/guards/file-by-id.guard.ts`, AI tool execution и workflow context. Не править их все заранее; этап 0 определяет общий разрешённый hook и обходы.

1. Зафиксировать fixture matrix manager A/B/lead/admin/AI/app, clients X/Y, shared thread, visible/hidden stages. Product role matrix ещё уточняется; fixtures не являются реальной настройкой сотрудников.
2. Объединить существующие object/field permissions с независимой запись-уровневой политикой. Scope применяется до DB read/filter/order/groupBy/count/export, не post-filter в UI. Не reuse Enterprise RLS predicates, не подменять entitlement. Для system bypass у существующих writers явный audit и узкий approved purpose.
3. CRUD, назначение/шаринг, доступ к файлам/подпискам, изменение прав и инвалидирование кеша/AI-контекста. Связь клиента с диалогом не открывает все сделки клиента.
4. Переходы stage: domain validation внутри mutation transaction, одинаковая для UI/generic API/AI/workflow; запрещённый переход отклоняется до изменения и фиксируется в audit. Default allow-all не вводится.
5. Закрыть прямое изменение route/controlEpoch/actor/system fields через generated API. File download с актуальными ACL; ранее выданные внешние capabilities отдельно ограничены.

**Verify:** negative tests для всех mapped entry points, 2 workspaces, shared/private conversation, orphan/deleted records, revoke during pagination/export/SSE/AI, hidden stage aggregate и field masking. Сначала минимальный query/predicate test, затем DB integration и UI. Audit отказа не раскрывает объект неавторизованному actor.

**Done when:** матрица запретов проходит на Free/self-hosted, включая прямой API; не осталось немаркированного system bypass. Можно безопасно проверять multi-manager UI.

**Rollback:** при выключении новой политики protected объекты недоступны, а не возвращаются к широким upstream grants. Не выкатывать fallback «разрешить всё» ради доступности.
