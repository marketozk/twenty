# Этап 4. Коннекторы и рабочий чат Telegram/MAX

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Зависимости: 1, 2a, 3; fake transport можно проверять раньше в изолированных тестах. Статус: не выполнен.

**Новые:** server `modules/omnichannel/{controllers/connector-events.controller.ts,services/conversation-command.service.ts,jobs/dispatch-outgoing.job.ts,services/connector-client.service.ts}`; front `modules/omnichannel/{pages/,components/,hooks/}`; contract fixtures в `integrations/messaging/contracts/`.

**Существующие внешние файлы:** из [research-connectors.md](../research-connectors.md): C `salebot-connector/bridge/{models.py,store.py,server.py,worker.py,partner_api.py,userbot.py}`; Telegram `telegram-userbot/app/{transport.py,store.py}`; M `Userbots-Max/src/{bridge_adapter.py,bridge_journal.py}`. Путь `bridge/userbot.py` повторно проверен; внешний код пока не переносился. Новые Twenty adapters размещать в этом проекте после проверки лицензий и отслеживаемых ревизий; рабочие checkout/контейнеры не менять побочно.

1. Контракт events/commands/receipts v1: binding-scoped auth, schema validation, routeGeneration, payload hash, stable commandId, status query. Fake connector воспроизводит timeout до/после ACK, late receipt и echo.
2. Выделить Twenty sink и transport dispatch без SaleBot mirror/card/project обязательных зависимостей. Существующие transport idempotency, unknown handling и media safety сохранить; live SaleBot route не переключать.
3. Источник outbound retry только connector/adapters. Повтор CRM enqueue с тем же ID возвращает тот же job; accepted не значит sent. Согласовать native-ID/echo correlation и необратимую границу dispatch/takeover.
4. UI: список, сообщения, поиск, unread, карточка CRM, assignee/participants, internal note, pending/sent/failed/unknown, статус подключения. Только authenticated Twenty API, не токен коннектора в браузере.
5. Подключить subscriptions с cursor recovery и проверкой права на каждую выдачу; privacy-revoke удаляет недоступную ленту/кеш и прекращает поток. UI audit из 2b может завершаться отдельно.
6. Тестовые Telegram и MAX маршруты: receive/send, два разрешённых менеджера, чужой менеджер, повтор, reconnect. Нужны специально выбранные аккаунты/адресаты; не отправлять клиентам ради smoke test.

**Verify:** contract suite, DB state machine, UI component tests и e2e на fake transport; затем реальные тестовые сообщения обоих каналов. По одному commandId найти весь audit/receipt chain и один видимый bubble; для неизвестного исхода не заявлять отсутствие дубля без провайдерного доказательства.

**Done when:** оба канала проходят полный путь и сбои, история/отправки работают при недоступном SaleBot на тестовом маршруте; отсутствуют общие пароли менеджеров и прямой browser send.

**Rollback:** остановить omni dispatch, дренировать/разобрать accepted/unknown; сохранить журнал и generation. Откат UI сам по себе не переключает транспорт.

## Обязательные уточнения transport и Composer

Перед активацией выбранного аккаунта G11/G13: read-only inventory владельцев CRM dispatch и сторонних отправителей/маршрутов. Один sender означает одного CRM-dispatch owner на generation; внешние сервисы/люди отдельно классифицированы. Никакой интеграции с тендерным роботом и побочных изменений его сервисов. Unknown source/conflicting owners блокируют activation до разрешения конфликта; external_service требует journal provenance и отдельной выбранной policy, до выбора pause/handoff.

Composer reply передаёт replyToMessageLinkId; native reference вычисляет сервер, unsupported/deleted target даёт ошибку. T12 проверяет foreign target, capability, payloadHash и CAS/idempotency. T11 проверяет FIFO первого durable enqueue: задержка A, конкурентный B, потерянный ACK, accepted A с неизвестным provider outcome. Нет гарантии порядка provider delivery; явный manual replacement сохраняет unknown и предупреждение. Точное правило §4 spec, не скрытый retry.

Выбран единственный существующий session-owner process с обновлением provider boundary и сохранением journal. Temporary authenticated legacy principal generation0 допускается только до switch; затем unversioned C отклоняется userbot. Rollback требует нового поколения/credential и совместимого adapter, иначе fenced. Exact handshake/failure cases — spec §15.25. Развёртывание выполняется отдельно после квалификации, не при переносе исходников.

Human send observedSequence обязателен; stale_view → показ нового события и явное подтверждение, key/hash сохраняются. Manual replacement также ждёт неизвестный acceptance предыдущего Command, ordering waiver нет. Лента сортируется по времени сообщения и его стабильному идентификатору, sequence только доставка/unread/CAS; T12/T13/T16.
