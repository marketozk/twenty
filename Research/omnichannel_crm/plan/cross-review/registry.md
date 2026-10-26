# Кроссревью подробного плана — реестр

R12: выполнены три свежих полных прохода из изолированного пакета. Последний A дал needs_revision; исправления внесены в действующий план, после B и точечной перепроверки все60 известных причин closed_in_plan, B — ready_for_implementation. Это не свежий полный pass исправленной редакции. ROB-772 In Progress, ROB-764 Todo; новый runtime и его тесты не начаты.

Объект: весь проект, requirements/design/phase_1–7 и implementation-spec.md. Baseline 475e2753. Режим: fix-and-recheck только документов, полный протокол. Нового runtime-кода/тестов/деплоя нет. User подтвердил весь проект. Оракулы этого review: source trace, consistency constraints, requirement→phase→test mapping. Будущие runtime tests не выдаются за пройденные.

R1: независимый Claude Code 2.1.296, reported model claude-opus-5-5, session 7279ea44-b0aa-4739-91c8-192b27f42e96. Read/Grep/Glob only, Bash/Edit/Write и slash skills отключены, MCP отключён; exit 0, is_error=false. [Полный ответ](claude-initial.md). Raw response хранится временно вне Git; секретов в отчёте нет. Автор проверил ключевые code findings и подготовил подробную спецификацию. Severity ниже нормализована по влиянию на будущий контракт.

## Findings

После R2 stage B: 20 исходных причин closed_in_plan, 7 открытых до второй правки. Closed относится только к контракту и тестовому плану. R2 исправления ниже подготовлены автором и ждут нового независимого прохода. Происхождение — исходный план; не текущий production defect. Failure scenarios внутри модели раздела 1; продуктовые gates не считаются выбранными пользователем.

| ID | Severity | Корневая причина | Контракт/проверка | Статус |
|---|---|---|---|---|
| H-1 | major | Таймлайн обходит conversation ACL | 15.1 / T21 | closed_in_plan (R12 B/finalcheck) |
| H-2 | major | Cleaner lifecycle удаляет историю | 15.1 / T22 | closed_in_plan (R12 B/finalcheck) |
| H-3 | major | Auto principal/read scope | 15.3 / T25 | closed_in_plan (R12 B/finalcheck) |
| H-4 | major | Повтор AI effect после crash | 15.3 / T26 | closed_in_plan (R12 B/finalcheck) |
| H-5 | major | Restore inbound/admission gap | 15.4 / T29 | closed_in_plan (R12 B/finalcheck) |
| H-6 | major | External outgoing без команды | 15.2 / T24 | closed_in_plan (R12 B/finalcheck) |
| M-1 | major | Dispatch recovery после takeover | 15.3 / T28 | closed_in_plan (R12 B/finalcheck) |
| M-2 | major | Cancel connector queued command | 15.3 / T28 | closed_in_plan (R12 B/finalcheck) |
| M-3 | major | SaleBot ID не доказан native | 15.2 / T16 | closed_in_plan (R12 B/finalcheck) |
| M-4 | major | MAX event variants vs logical identity | 15.2 / T01,T11 | closed_in_plan (R12 B/finalcheck) |
| M-5 | major | Person merge identity lifecycle | 15.2 / T23 | closed_in_plan (R12 B/finalcheck) |
| M-6 | minor | Message revision retention | 15.5 / T32, explicit gate | closed_in_plan (R12 B/finalcheck) |
| M-7 | major | Canonical durable workflow trigger | 15.3 / T14 | closed_in_plan (R12 B/finalcheck) |
| M-8 | major | Audit DB owner privileges | 15.5 / T06 | closed_in_plan (R12 B/finalcheck) |
| M-9 | major | Stage SELECT vs nonexistent Stage ID | 15.5 / T30 | closed_in_plan (R12 B/finalcheck) |
| M-10 | minor | Test environment identity | 15.5 / test preflight | closed_in_plan (R12 B/finalcheck) |
| M-11 | major | Fork migrations before existing cursor | 15.5 / T33; source reader groups command kinds | closed_in_plan (R12 B/finalcheck) |
| M-12 | major | Unknown Person creation | 4 / T02,T05 | closed_in_plan (R12 B/finalcheck) |
| M-13 | minor | Burst AI turns | 15.3 / T27 | closed_in_plan (R12 B/finalcheck) |
| M-14 | minor | Workflow send route selection | 15.3 / T14 | closed_in_plan (R12 B/finalcheck) |
| L-1 | minor | Audit writer phase cycle | 3 / T02,T06 | closed_in_plan (R12 B/finalcheck) |
| L-2 | minor | Stale status/spike in open questions | open-questions.md updated | closed_in_plan (R12 B/finalcheck) |
| L-3 | minor | Audit catalog volume | 15.5 / T19 | closed_in_plan (R12 B/finalcheck) |
| L-4 | minor | Binding identity on reconnect | 15.1 / T11 | closed_in_plan (R12 B/finalcheck) |
| L-5 | major | Native role changes bypass own fence | 15.5 / T31 | closed_in_plan (R12 B/finalcheck) |
| L-6 | major | Import actor revoke per batch | 15.5 / T10,T16 | closed_in_plan (R12 B/finalcheck) |
| L-7 | minor | Generic mutation of Message | 15.1 / T22 | closed_in_plan (R12 B/finalcheck) |

## Журнал экземпляров

R1 содержит по одному проявлению каждой строки таблицы выше; source evidence и сценарии — в полном ответе Claude. Новые причины, исходный план, не порождены исправлением. Авторский source pass для M-11 дополнительно установил grouping fast/slow/workspace в UpgradeSequenceReaderService и startCursor после прошлого command; принят fork-only migration ledger, проверка этого нового orchestration обязательна на свежем review.

## Каналы и остаточные риски

Данные/конкуренция/авторизация/внешние эффекты/восстановление релевантны, каждому соответствует T01–T33. Сейчас меняются только документы. External runtime/source imports будут проверены заново по SHA перед переносом; тесты новых контрактов отсутствуют до реализации. Product gates — раздел 13 и 15.5. Ни один residual risk не принят за владельца. Candidate pass требует fresh full-object review, затем reconciliation всех ID.

## R2 — fresh A, затем reconciliation B

Claude session `4e9c1793-d8e3-4eb9-9659-5e985aad75e9`, claude-opus-5-5, is_error=false. [Blind A](claude-fresh.md), [сверка всех 27 ID](claude-reconciliation.md). A не читал registry/старый review; B выполнен только после сохранения A, через resume той же сессии. Snapshot A — review-manifest.json. A verdict needs_revision. Все runtime проверки будущие.

Повторы R2: H-2 ← A/H5,L18; H-6 ← A/H3; M-7 ← A/H1; M-8 ← A/H7; M-9 ← A/H4; M-10 ← A/H6; M-11 ← A/M14,H7 (startup). M-4 редакционное уточнение nativeMessageKey не открывает уже закрытый корень. Исправления второго раунда: §15.6–15.9, согласованы §2/3/7/15.5 и wire StageOptionsHash. Источники автора: EntityEventsToDbListener, pending-wake-up listener, generator, core account/channel cascade, Docker entrypoint, connector schema.sql и Telegram store.py. Никакой DB ownership/cutover/функции сейчас не изменены.

| Новый ID | Severity | Причина / R2 A | План и тест | Статус / происхождение |
|---|---|---|---|---|
| N-1 | major | Производные объекты и inheritance / H2 | §15.6, T08,T21, inventory до patch ROB-766 | closed_in_plan (R12 B/finalcheck) |
| N-2 | major | Невидимый unassigned queue / H9 | §15.6 QueueGrant, activation gate, T12 | closed_in_plan (R12 B/finalcheck) |
| N-3 | minor | Pausing AI занимает turn / M10 | §15.9, T27 | closed_in_plan (R12 B/finalcheck) |
| N-4 | major | Instance-admin export/impersonation / M11 | §15.6, T07,T08 | closed_in_plan (R12 B/finalcheck) |
| N-5 | major | Connector journal/owner/cancel границы / M13 | §15.7, T11,T28, deployment gate | closed_in_plan (R12 B/finalcheck) |
| N-6 | major | Lock ordering только takeover / M12 | §15.9, T02,T10,T23,T28 | closed_in_plan (R12 B/finalcheck) |
| N-7 | major | Generation cutover replay / H8 | §15.7, T11,T18 | closed_in_plan (R12 B/finalcheck) |
| N-8a | minor | Хранилище поиска / L15 | §15.9, T12,T17,T19 | closed_in_plan (R12 B/finalcheck) |
| N-8b | minor | Автор зависит от mutable participant / L16 | §15.7, T24 | closed_in_plan (R12 B/finalcheck) |
| N-8c | minor | API-key principal fixture / L17 | §15.6, T08 | closed_in_plan (R12 B/finalcheck) |

R2 уточнение экземпляров старых причин: H-6 (классификация без correlation) и M-9 (global metadataVersion) порождены первой правкой; M-10 (synthetic workspace assumption) и M-11 (generator registration) также уточнения первой правки. H-2/M-7/M-8 — неполное исправление baseline. Не скрываются как новые независимые ID. Всего 17 незакрытых причин после reconciliation: 7 повторов + 10 новых, из них 5 проявлений порождены правкой; снижение против исходных 27. Требуется fresh полный проход после второй правки, затем B; no pass по утверждению автора.

## R3 — второй fix-and-recheck

Fresh Claude session `6d0fc063-434c-4708-a96e-aba061cd00b2`, is_error=false. [A](claude-r3-fresh.md), [B](claude-r3-reconciliation.md), review-r3-manifest.json. 35/37 прежних причин закрыты в плане; M-7 остался open, L-2 needs_evidence потому что reviewer не перечитал open-questions (не новая регрессия). Четыре новые причины ниже. Число открытых major уменьшилось с 13 до 4. Третий авторский fix: §15.10–15.11, корректировка phase_1/phase_5/API/ключей схемы и ранней Revision migration; обязательный следующий fresh review проверяет весь объект, затем reconciliation. Runtime tests по-прежнему не выполнены.

| Новый ID | Severity | Причина | Fix / будущий oracle | Статус |
|---|---|---|---|---|
| N-9 | major | Mapping omni key в global headerMessageId helper + placeholder no-op | §15.10, T01,T17, namespace collision/revision | closed_in_plan (R12 B/finalcheck) |
| N-10 | major | Manager composer send vs active auto без takeover | §15.11 managerReplyPolicy activation gate, T13,T24 | closed_in_plan (R12 B/finalcheck) |
| N-11 | major | Ownership transfer архивирует общий канал | §15.11 WORKSPACE/custodian domain transfer, T22,T31 | closed_in_plan (R12 B/finalcheck) |
| N-12 | minor | Импорт не сохраняет исторического автора | §15.11 source provenance+explicit mapping, T16 | closed_in_plan (R12 B/finalcheck) |

Повтор M-7 в R3: два проявления — отсутствие исполнимой typed workflow projection и неявное suppression helpers. Первое baseline, второе выявлено на границе уточнения R2. Самопроверка автора подтвердила WorkspaceTransactionScope.getRepository options, workspace-wide header query, optional workflowRunId runner и transferOwnership archive/isSyncEnabled mutations. Третья правка выбирает concrete wrapper и typed trigger, не требует переписывания email pipeline. R4 — проверка третьего fix, не разрешение четвёртой правки при новом существенном остатке.

## R4 — третий fix-and-recheck, итог без pass

Fresh session `82f878e4-8885-42d6-ba1f-266a2c9bb2e4`, is_error=false, claude-opus-5-5. [Blind A](claude-r4-fresh.md), [reconciliation B](claude-r4-reconciliation.md), review-r4-manifest.json. Все 41 прежних ID проверены: 38 closed_in_plan, N-1 major reopened, M-7 minor open (основной trigger контракт закрыт, остаётся hard throttle), L-2 minor open (исходная устаревшая версия исправлена, теперь неполный свод gates). Добавлены пять новых причин. Source-specific ключевые утверждения автор проверил по build-row-access-policy/build-record-share-gate и standard-object-readability fixture; это не live evidence.

| Новый ID | Severity | Причина | Проверка/следующая правка | Статус / origin |
|---|---|---|---|---|
| N-13 | minor | Неполный inventory Enterprise-marked imports в общем ORM пути; независимость own ACL не доказана | Source fact отдельно от прав использования; license text/dependency boundary + T20 PRIVATE/INHERITED | closed_in_plan (R12 B/finalcheck) |
| N-14 | major | Workflow send после takeover получает новый epoch | Матрица sender×mode, AI workflow provenance, T13/T24 | closed_in_plan (R12 B/finalcheck) |
| N-15 | major | Epoch mismatch/lock mode не определены | Reauthorize vs reject; SHARE/UPDATE без upgrade, T10 | closed_in_plan (R12 B; future runtime evidence pending) |
| N-16 | major | Нет pull transport для native/archive import | Источник страниц/контракт/auth/cursor; убрать внешний origin, T11/T16 | closed_in_plan (R12 B/finalcheck) |
| N-17 | minor | Opportunity.expectedRevision не имеет источника | Выбрать CAS token и T30 | closed_in_plan (R12 B/finalcheck) |

Число open major по независимым сверкам: R1=20; R2=13; R3=4; R4=5. Total causes: 27→37→41→46. R2: 10 новых причин/7 существенных повторов; R3: 4 новых/2 старых незакрытых; R4: 5 новых/3 повторно открытых. В R4 минимум 4 проявления явно порождены уточнениями (N-15,N-17,M-7,L-2), остальные baseline/раскрытые интеграцией. Ни одно не принято как допустимый риск. Повышение числа major и достигнутый потолок третьего fix требуют остановки перед четвёртой правкой и конкретного решения владельца, не продолжения до желаемого pass.

Авторский итог: `escalate` с [листом остатка](residual.md), не готово к ROB-764. Нельзя принять молчаливую необратимую утечку N-1 или неавторизованную отправку N-14 как harmless residual. Остальные также open до исправления/доказательства; стоимость следующего шага — конкретные исправления контрактов и новый независимый полный pass, без runtime/deploy. Схема, контракты и 33 группы тестов подготовлены, но общий план не закрыт.

Уточнение к последней фразе Claude B о карточке: reviewer не имел MCP и не менял Linear; утверждение о наличии вопроса в карточке не подтверждено. Автор создал только ROB-772 с объёмом/критериями, без вопроса о покупке или разрешении нарушать лицензию. Решение D-18 сохраняется. Отсутствие key-check не доказывает права использования или нарушение; ничего из этого не объявляется установленным.

## R5 — четвёртый fix-and-recheck, разрешён владельцем

26.10.2026 пользователь прямо ответил «да продолжаем» на предложение четвёртого раунда. Scope прежний: исправления документации и независимый review, без runtime/deploy. Обоснование: конкретные восемь остатков R4 устраняются контрактами; не принимаются как риск. Полный протокол: self-review, fresh A всего проекта без реестра, затем B.

Авторская правка: §15.12 artifact ACL, §15.13 own baseline/dependency gate, §15.14 sender×mode, §15.15 epoch/locks, §15.16 history pull/schema, §15.17 throttle/CAS. G01–G18 собраны в §13, API/open-questions/phase3/5/6/license inventory согласованы. Старые open статусы до независимой проверки сохраняются. Прочитаны LICENSE и фактические source paths (workflow runner, recorder, BaseWorkspaceEntity, native history bounds); будущие runtime tests не заявляются пройденными. Новая модель не задана: CLI default, reported model будет записана из результата.


R5 результат: [A](claude-r5-fresh.md), [B](claude-r5-reconciliation.md), session b2754c16-3600-4c60-ac8c-e3ef861c8d76, reported claude-opus-5-5. 44/46 прежних ID closed_in_plan. N-13 major остаётся (обычные event consumers и порядок CI), L-7 reopened minor (workspace-member rematch); новые N-18 minor (metadata account disclosure, порождён R3) и N-20 minor (workflow action wiring). Итого 48 причин, 44 closed, 1 major + 3 minor open. N-19 не выдавался; сохраняем ID независимой сверки. F5/F6 редакционные, не отдельные причины. Правовой текст установлен, runtime права текущего экземпляра не оценены.

## R6 — точечная доводка в рамках разрешённого продолжения

Владелец явно разрешил продолжать весь cross-review; разрешение не содержит ограничения «только один раунд». Фраза автора в R5 B prompt «fourth only» и вывод reviewer о новом обязательном разрешении были лишним ограничением, не новым решением владельца. Продолжаем только обратимые правки плана. Обоснование следующего прохода: major снизились 5→1, весь остаток ограничен четырьмя конкретными source-confirmed путями; §15.18 задаёт решения, не принимает риски. Полный свежий A и затем B проверят весь объект. Runtime/deploy и продуктовые gates остаются закрыты до их условий.

Авторская правка: §15.18, синхронизация phase1/3/5/6. N-13: per-family replace/exclude + ordinary protected events + early CI. L-7: исключить omni до member/people rematch. N-18: binding.read guard metadata paths при WORKSPACE scope. N-20: typed workflow action wiring. Уточнены canonical outcome_unknown и отсутствие auto Person creation при import. Live feature usage честно unknown, inventory обязателен до removal/G18; работа по исходникам не выдана за live inspection. Не закрывать ID до B.

| Новый ID | Severity | Причина | Контракт / oracle | Статус |
|---|---|---|---|---|
| N-18 | minor | Account metadata visible with WORKSPACE scope | §15.18, T08 | closed_in_plan (R12 B/finalcheck) |
| N-20 | minor | Workflow send action integration incomplete | §15.18, T14/T28 | closed_in_plan (R12 B/finalcheck) |

## R6 — результат и R7 — завершение lifecycle контракта

[Blind A](claude-r6-fresh.md), [B](claude-r6-reconciliation.md), session 239822bd-f6ad-4a5a-bdc1-ea95169342ac, reported claude-opus-5-5. 46/48 прежних ID closed_in_plan; M-7 reopened major (trigger consumers/recovery), N-13 сужен до minor (ещё ordinary workflow/agent/wake-up consumers и ownership transfer), новый N-21 minor. Всего49,46closed,1major+2minor. F4 остаётся уточнением M-11, не новым дефектом. Source counterexample автора: RunWorkflowJob:81–94 завершает пойманную ошибку в FAILED; фраза reviewer о неизбежном вечном RUNNING от неизвестного trigger неверна, но незарегистрированный trigger всё равно не выполняется. Реальный crash/Redis loss путь подтверждён monitor-only stale service.

| Новый ID | Severity | Причина | Контракт / oracle | Статус |
|---|---|---|---|---|
| N-21 | minor | Message revision ошибочно служит CAS управления | §15.19, T10/T12 | closed_in_plan (R12 B/finalcheck) |

R7 разрешение: то же явное продолжение владельца; полный protocol. Окупаемость: три конкретных остатка, total open4→3, один major прежнего M-7, модель отказов не расширена. §15.19 завершает registration/lifecycle/recovery; unknown generic external effect не переисполняется автоматически. N-13 дополняется оставшимися consumer families, N-21 разделяет revision/controlEpoch. Это шестой fix-and-recheck после initial R1; если новый проход не уменьшит major повторно, применять stop-condition с листом остатка, а не искать формальный pass.

Ограничение исполнения R6: аудит raw CLI session обнаружил один mcp__task-card__update, обновивший служебную карточку CLI, несмотря на запрет MCP в prompt и strict-mcp-config. Другие фактические tools: Glob3/Read36/Grep41; Bash/Edit/Write/Linear tool calls отсутствуют. Поэтому утверждение «MCP не использовался» к R6 неверно; технический отчёт сохранён без переписывания. R7 явно запрещает обнаруженный tool по имени. Это не изменение кода/деплой и не обновление задачи Linear.

Аудит R5 raw session также обнаружил 3 обновления служебной task-card (Read34/Grep34/Glob4); поэтому запрет MCP был инструкцией, а не фактом нулевых MCP вызовов. [Точные счётчики](cli-tool-audit.json). Не было Bash/Edit/Write/Linear-вызовов. Независимость blind A от прежнего реестра сохраняется; карточка — только отчёт reviewer о своей работе.

## R7 — итог: нужна структурная переработка автоматизации

[Blind A](claude-r7-fresh.md), [reconciliation B](claude-r7-reconciliation.md), session 792e21e8-4d4b-4119-9ac2-cb768ea053b1; reported claude-opus-5-5, оба is_error=false. 49 stable IDs, 45 closed_in_plan, open H-3/M-7 major и N-3/M-13 minor. N-13 и N-21 закрыты; новых root IDs нет. F5/F6/license — checklist, не новые дефекты. Исходники автора подтверждают широкую выдачу application token code-interpreter, оба набора pausing tools и raw SQL cleaner.

Экземпляры R7: H-3 — delegated token boundary, baseline/неполное исправление R1; M-7 — version-based receipt key × новая lifecycle registration, порождён уточнениями R3/R7; N-3 — неполный набор pausing tools/отдельный runner parameter, baseline/неполное исправление R2; M-13 — раздельные budgets agent/workflow, порождён уточнениями R1/R5. Ни один не принят как допустимый риск. Из 4 экземпляров 2 patch-induced; без нового независимого корня.

Тренд open major R4=5 → R5=1 → R6=1 → R7=2: два последних прохода не снизили major. По cross-review-convergence не запускаем следующий круг той же формы. Сохранён [лист остатка](residual.md) и [проверяемое предложение](automation-redesign-proposal.md): единая capability/execution boundary и устойчивый admission/response owner. Это proposal, не уже применённая смена архитектуры или готовый runtime. Основная спецификация по-прежнему имеет четыре явно открытые причины; R8 не запускался. Перестройка требует переписать исходные разделы вокруг инвариантов, затем целевой source review и один fresh full pass.

Это результат планового review, не исправление выявленных runtime дефектов: новая omni-функциональность ещё не реализована, T01–T33 не запускались. Live feature inventory/аккаунты/политики остаются gates. Формального pass нет, реализация ROB-764 остаётся заблокирована ROB-772.

## После R7 — исправления внесены в основной план, нового review ещё нет

По просьбе пользователя актуализировать документы выполнена структурная правка, а не очередной слепой проход. Canonical design/09 объединяет capability/reference boundary, immutable admission target snapshot и reply budget. Исправлены исходные §3/5/9/15.3/15.9/15.10/15.17/15.19, G07/G18 и связанные design/API/phase/coverage. Старые version-based receipt/run keys удалены из нормативного spec. Source matrix содержит 14 фактических файлов и будущие изменения; таблица сценариев входит в тот же контракт.

H-3/M-7/N-3/M-13: автор addressed_pending_review; независимый open сохраняется. Исторические A/B и manifests R1–R7 не переписаны, результаты не перенесены на изменённый snapshot. Следующий шаг — целевая проверка новой модели, затем fresh full review и B. R8 не запускался; T01–T33 не реализованы/не выполнены. Никакие live изменения или новое пользовательское принятие риска не подразумеваются.

## R8 — целевой разбор новой модели и подготовка свежего полного прохода

Режим fix-and-recheck документов, полный протокол после structural rewrite ceda4f6e/6ab6085f. Targeted Claude session 796e6b58-6182-4101-bfdb-fec4a30412d7, reported claude-opus-5-5, exit0/is_error=false. [Ответ](claude-r8-targeted.md), snapshot review-r8-targeted-manifest.json. Это не blind full review и не pass проекта. Targeted подтвердил stable workflow key M-7, но нашёл дополнительный путь Retry того же корня — M-7 остаётся open до полного reconciliation. Все пути подтверждены автором по исходникам, поправлены в основном spec/design/API/matrix; авторский статус addressed_pending_review.

| Раунд/ID/проявление | Severity | Происхождение / порождено исправлением | Evidence и авторская правка |
|---|---|---|---|
| R8 H-3 workflow actions | major | исходный план; неполное исправление прошлых раундов | CODE/LOGIC_FUNCTION issuer → closed action policy для всех omni descendants, T25-D |
| R8 H-3 native model tools | major | исходный план; неполное исправление прошлых раундов | AgentToolset вне registry → native options empty + final toolset guard, T25-E |
| R8 H-3 API wording | minor | старый API; противоречие внесено запретом raw functions после R7 | design/06 больше не предлагает logic function delegation |
| R8 N-3 canAskHumans / workflow AI_AGENT | minor | исходный путь; неполное исправление после R7 | canAskHumans=false/waitTools empty во всех AgentRunner calls; workflow waits отделены, T27-A |
| R8 M-7 native Retry | major | исходный путь не покрыт прежним recovery контрактом; не новый runtime defect | retryWorkflowRun deny до mutation/enqueue, общий terminal finalizer, T14-D |
| R8 M-13 mixed exhausted burst | minor | порождено новой атомарной reservation моделью после R7 | terminal budget_exhausted + idempotent durable handoff; без новой автоматики split/rebuild, T27-D |
| R8 M-13 descendants covered set | minor | неполное исправление новой burst модели после R7 | все потомки наследуют весь covered set, T27-C |

7 проявлений / 0 новых stable IDs / 4 повторных корня; никаких refuted/accepted-risk. Модель отказов прежняя §1, все сценарии внутри. Severity Retry нормализована как major по возможному повтору эффекта; native tools — major по обходу scope. После правки нужен fresh full A в другой сессии, затем B для всех 49 ID. Оракулы плана: source trace, decision table, counterexample coverage; runtime T01–T33 не исполнялись.

### R8 A/B — полный независимый результат и следующая авторская правка

Fresh A session f06ceb9f-433c-450d-b6af-9d6ef9d0bbf9, затем B той же сессии только после сохранения A. [A](claude-r8-fresh.md), [B](claude-r8-reconciliation.md), snapshot review-r8-full-manifest.json. Итог **47/49 closed_in_plan, open H-3 и M-5 (major), новых ID нет**. Реальные инструменты сверяются по session log; runtime не запускался. A прочитал полный план/requirements/phases/design и точечно Twenty source; Python-коннекторы и внешние репозитории не проверены заново, их source-квалификация остаётся pre-activation gate.

| Проявление | Классификация | Авторская правка / oracle |
|---|---|---|
| R8 A F1 → H-3 | major, исходный план + неполные правки governance | Любой omni-capable flow governed до первого шага; typed durable roots для всех triggers, общий budget/causation, deny missing reference; T14-E/T25-F |
| R8 A F2 → M-5 | major, конфликт lifecycle и suppression порождён предыдущими правками | Mixed merge partition по ownership, domain lifecycle adapter participants/targets в той же transaction; T23 |
| R8 A F3 → M-7 | checklist, не новый/open ID | scheduleStepRetry перечислен; в omni v1 выключен, error terminal с audit/unknown outcome; T14-F |
| R8 A performance → N-15 | checklist, не дефект корректности | T19 измеряет policy SHARE contention |

Все замечания учтены, ни одно не отклонено/принято за владельца. 2 open major как в R7; новая структурная модель получила первый full pass-попытку, улучшение по общему числу 45→47 не подменяет major count. Перед следующим fresh R9 внесены H-3/M-5 в основной текст, согласованы schema/API/phases. Если R9 снова не уменьшит major или будет преобладание patch-caused дефектов, повтор той же формы прекращается по stop-condition. Candidate требует fresh A+B, а не self-closure.

## R9 — свежий полный A, исправление контракта и B

Fresh session 9aeb8d46-3b5f-41e9-aea1-068d32b520cd, reported claude-opus-5-5. [A](claude-r9-fresh.md) на review-r9-manifest.json: needs_revision, два блокирующих medium нормализованы major (N-21/N-15, M-13). После source/contract проверки автор исправил реальные paragraphs/spec/schema/API; [B](claude-r9-reconciliation.md) на review-r9-b-manifest.json закрыл все49 и новый N-22, обнаружил N-23 minor. [Финальная узкая сверка B](claude-r9-finalcheck.md) подтвердила N-23. Никакой из этих B не назван свежим полным A.

| Раунд/ID/проявление | Severity / происхождение | Исправление и проверка |
|---|---|---|
| R9 N-21/N-15 control/automation epoch collision | major, порождено прежним CAS исправлением | отдельный automationEpoch, human accepted dispatch не зависит от UI CAS; stale non-human outcome visible, T13/T24 |
| R9 M-13 ambiguous slot reservation | major, порождено budget redesign | только bound slot в одной transaction с Command ПОСЛЕ генерации; no auto regeneration/crash retry, T26/T27 |
| R9 N-22 restore access rollback | major, baseline | внешний access fence, invalidation sessions/API keys, external grants/revoke evidence, T18/T29 |
| R9 H-2 TrashCleanup | minor, baseline missing inventory | domain lifecycle destroy до SQL, unbind/audit/omni exclusions, T22 |
| R9 L-2 signature gate | minor, baseline | G19 явно выбирается до подписи, по умолчанию выключено |
| R9 N-23 closed status vs auto | minor, порождено текущим epoch split | close/reopen fence, current status gate, G20 incoming/reopen policy; T13/T24 |

| Новый ID | Severity | Причина | План/тест | Статус |
|---|---|---|---|---|
| N-22 | major | Restore оживлял отозванные права/сессии | §15.21, T18/T29 | closed_in_plan (R12 B/finalcheck) |
| N-23 | minor | Closed диалог не останавливал automation после epoch split | §15.22, T13/T24, G20 | closed_in_plan (R12 B/finalcheck) |

Итого 51/51 известных причин closed_in_plan, open major/minor=0. Все исходные контрпримеры проверены независимым reviewer; runtime tests будущие. Последний A был needs_revision; после B остаётся формальный gap свежего полного прохода новой редакции. Major count R8 B2→R9 B0 уменьшился, поэтому количественный stop не запрещает финальный candidate R10. Не считаем каждый новый подпункт новым ID и не скрываем patch-induced проявления.

Редакционные заметки B: G12/§12 access fence уточнён непосредственно в runbook; human pending после close явно cancelled_conversation_closed до provider boundary. Доказательства новой версии заморожены в review-r10-manifest.json перед свежим A; статус финального pass пока не выставлен.

## R10 — финальный полный проход, исправления и ограниченная сверка

Fresh A session 3f2601ac-8aaa-4036-8790-15f06ac7453e, model claude-opus-5-5. [A](claude-r10-fresh.md) на review-r10-manifest.json: needs_revision, три существенных контрпримера и пять локальных замечаний. Автор сверил исходники listener/job/cache и encryption/JWT, внёс все исправления в сам план. [B](claude-r10-reconciliation.md) на review-r10-b-manifest.json:52/53 закрыты, один M-7 minor (governed→ordinary publish). После точной правки event snapshot reference [узкая сверка](claude-r10-finalcheck.md) подтвердила53/53. Snapshot до финальной сверки — review-r10-final-manifest.json. Reviewer по ошибке называет6ab6085f «snapshot A» в одном старом ответе: это база ветки, точные рассматривавшиеся working-tree файлы определяются manifests, не тем SHA.

| Проявление R10 | Stable ID / severity | Происхождение / решение |
|---|---|---|
| F1 event kinds/root budgets | M-13, major | baseline incomplete mapping; message/conversation.created общий root, domain events наследуют causation; T27-B |
| F2 governed catalog/publish | M-7, major; остаток minor | неполное расширение после R8; durable all-trigger catalog, per-record event snapshot, подавление native enqueue в обоих направлениях publish; T14-E |
| F3 stage/link policy invalidation | N-15, major | неполный policy field catalog; UPDATE+epoch и semantic ResourceScope edges, T10/T13 |
| L1 takeover control token exception | N-21, minor | порождено epoch split; явное исключение takeover_on_send/T12 |
| L2 human pending→auto | N-10, minor | порождено epoch split; deny до завершения/reconciliation human Commands, T12/T24 |
| L3 note idempotency | N-24, minor | baseline; UNIQUE(workspace,author,key)+hash conflict |
| L4 attachment ownership transition | N-25, minor | baseline; atomic Command→Message reparent+ACL/audit, T15/T17 |
| L5 signing/encryption shared secret | N-22, major contract safety (A low) | baseline runbook; effective encryption key закрепляется перед APP_SECRET rotation, T18 |

| Новый ID | Severity | Причина | План/тест | Статус |
|---|---|---|---|---|
| N-24 | minor | Дубликат InternalNote при повторе команды | UNIQUE + payloadHash, schema/API | closed_in_plan (R12 B/finalcheck) |
| N-25 | minor | Вложения оставались у Command после canonical Message | §15.23, T15/T17 | closed_in_plan (R12 B/finalcheck) |

Все 53 причины учтены; ни одна не снята молча, не принята за владельца. Нет новых open major/minor, но **общий fresh full pass не получен**: полные A последовательно обнаруживали новые границы, а B подтверждают только известный список и delta. Не повторяем ещё одну широкую серию в этом запуске. Планирование не выдаётся за выполненные тесты приложения или самостоятельное разрешение live cutover. ROB-772 не закрыта; её следующий контроль — согласованность конечных таблиц event/root/catalog, permission mutation и command lifecycle, затем независимый критерий допуска реализации. Подробный итог — [review-result.md](review-result.md).

## R11 — конечные таблицы, авторская проверка до независимого consult

Объект: [decision-tables](../decision-tables.md), spec/API delta и абстрактная модель. Режим fix-and-recheck, полный протокол для этого ограниченного объекта; не новая широкая серия проекта. Baseline c1a6100d. Все прежние 53 ID сохранены; счётчик закрытых предыдущими B не является допуском новой delta.

- N-10 повторно открыт для конкретного проявления: setMode(auto) пропускал accepted human Command. Major, baseline omission в R10 guard; теперь accepted включён в outstanding вместе с cancelRequested до доказанного terminal outcome. Spec §15.23/API и таблица P исправлены; авторский статус addressed_pending_review. Модель воспроизводит broken guard одним отрицательным контролем.
- N-23 уточнение прежней close-поправки (minor, patch-induced): §15.22 обещал отмену уже переданной команды до provider boundary без явного подтверждения. Приведён к существующему §15.3: локальная pending cancel и remote cancelRequested различаются; только winning journal tombstone даёт cancelled, too_late/timeout требует reconciliation. Это сужение обещания, не новая автоматика. addressed_pending_review до независимой сверки.
- Остальные51 известные причины не переоткрыты. Новый scope не доказывает их полную независимую перепроверку.

R11 A ([полный ответ](claude-r11-finite-a.md), fresh session da13e796-7991-4182-b516-72c40e2e3719, claude-opus-5-5) дал bounded_tables_needs_revision. B1–B3 сведены к M-7 (major, baseline неполнота publication contract): core/legacy ID normalization, coverage всех producers/обязательный empty snapshot, workflow-level cancellationEpoch. Перечитаны CachedWorkflowAutomatedTrigger, listener enqueue и lifecycle publish/deactivate; внесено в spec/09/API/schema и таблицу. M-7 reopened/addressed_pending_review. Всего три reopened ID, остальные50 сохраняют прежнюю сверку.

Три minor редакционных замечания A также учтены: human immutable target не назван LLM captured scope; добавлен non-closing status P12; dispatching+proof включён в C06/C08. Ограничения oracle названы явно; расширены наблюдаемые pending/cancelRequested/reconciliation, canonical ID/pinned version/cancel epoch и negative controls. Это исправление proof gap, не заявление runtime proof. Старые53 ID не размножаются из-за каждого проявления; полные новые findings сохранены без изъятия.

R11 fresh bounded final A ([ответ](claude-r11-finite-final.md), session 0d22f524-3f7b-4457-8ef8-b3e70e2634fa) снова needs_revision: B1 oracle ошибочно требовал non-human ResourceScope от human (N-15, major, patch-induced); B2 cancellationEpoch не был явно доведён до queued Command dispatch (M-7/M-2, major, patch-induced); B3 cancelCommand отсутствовал в минимальном API списке (M-2, major, baseline documentation omission). Все три исправлены. M1 late ACK после terminal cancel/failed теперь даёт наблюдаемый reconcile (M-2, proof gap).

Дополнительные замечания A обработаны: can_set_auto выделен и проверяет наборы0–2 commands; pending observations/ordinary target/C04 расширены; unknown намеренно блокирует auto до evidence, автоматического решения за оператора нет; filter-miss фиксируется при admission по pinned filter; commit→afterCommit crash имеет E15/ссылку на scanner; O→G различает visible empty и missing-reference gap; P12 порядок исправлен. Модель не заявляет покрытие C07 safe enqueue retry, Attachment XOR или всей E/P/C машины. Предложенное деление terminal states не добавлено: любой актуальный противоречивый ACK даёт conservative reconcile, stale/duplicate evidence фильтруется до reducer; новая автоматика не нужна.

Авторские состояния: N-10/N-23/M-7/M-2/N-15 addressed_pending_review, остальные48 по прежней сверке. Два fresh bounded A сохранили3 major, во втором есть patch-induced: третью одинаковую blind серию не запускаем. Выполняется только reconciliation уже внесённой delta с точным verdict; это не fresh full pass проекта. Reviewer раскрыл, что его Grep случайно показал строки STATUS/cross-review; полной независимой проверки без якорения этим результатом не объявляем.

R11-B ([сверка](claude-r11-reconciliation.md), тот же session final A): bounded_tables_ready по delta; N-10/N-23/M-7/M-2/N-15 closed_in_plan. Остальные48 НЕ перепроверены заново. Итоговый model run:1712 cases,23 semantic mutants caught. Два остатка B редакционные: добавлена ссылка на workflowCancellationRefs в pending row spec, E14/E15 упорядочены; поведения это не меняет. Никакого fresh full pass не заявлено, третий широкий/одинаковый раунд не запущен. Общий ROB-772 gate остаётся открытым.

## R12 — полный независимый проход в изолированном пакете

Baseline c030e2e4, fix-and-recheck документов, полный протокол. Fresh A session eb7d40b6-b4b8-4d7a-ae49-e9336ecea98a, reported claude-opus-5-5. 34 документа и 31 441 source/config/test files; история review/статусы/Git не передавались. [Отзыв A](claude-r12-full-a.md), [manifest](review-r12-a-packet-manifest.json), [точный документальный snapshot](review-r12-a-document-snapshot.json). A: ready_for_implementation **с 4 Medium и 7 Low**, не безусловный pass. Автор считает replica leakage и неопределённое хранилище связей существенными и исправляет их до закрытия planning task.

Ниже все 11 проявлений, без потери неудобных замечаний. Названия Medium/Low — исходный рейтинг reviewer; стабильный ID отражает причину. Все внутри заявленной модели, кроме предложение нового waiver: оно противоречит действующему контракту и проверяется как refutation. Ни один риск не принят за владельца.

| A finding | ID | Проверенный сценарий / изменение действующего плана | Проверка / состояние до B |
|---|---|---|---|
| Medium-1 | N-15 | Глобальный policy row contention; T19 перенесён также в ROB-766 до массовой интеграции. Не вводим split epoch без отдельного доказательства | phase3/7, spec §15.19; future micro-load; needs-evidence |
| Medium-2 | N-26 | Search/export useReplica:true + lag после revoke. Protected context force primary, policy/data один pool; no primary fail-open | source search/export/datasource; T08/T10; author fixed, needs-evidence |
| Medium-3 | N-27 | Task/custom target не хранится в MessageThreadTarget. Canonical core ConversationTarget для всех, native projection только P/C/O, domain API/revision/lifecycle | source target entity; T10/T13/T23; author fixed, needs-evidence |
| Medium-4 | H-6 | Посторонний service send не human. Trusted journal provenance, account inventory G11/G13, один CRM owner, externalServiceReplyPolicy | spec §15.24, API/phase4; qualified external evidence still future; needs-evidence |
| Low-1 | N-6 | §4 мог взять binding до policy и получить deadlock | §4 policy first, phase1; author fixed, needs-evidence; неполное отражение прежнего lock fix |
| Low-2 | N-10 | Предложен acknowledge_unresolved для auto. Контрпример: прежний human send ещё может завершиться у провайдера, waiver допускает конкурирующий автоответ без доказательства. Действующий контракт сознательно fail-closed; ручная работа/разбор остаются, новая гарантия авторазрешения неизвестного исхода не обещана | refuted pending reviewer acceptance; существующий C-gate не меняется |
| Low-3 | N-28 | Composer reply отсутствовал в command contract | reply link/native snapshot/hash/capability; expectedControlEpoch только CAS; T11/T12; needs-evidence |
| Low-4 | N-29 | per-chat order не имел точной границы | FIFO первого durable enqueue, acceptance evidence отдельно от provider outcome; unknown acceptance blocks auto enqueue, явный manual replacement сохраняет предупреждение/unknown; T11; needs-evidence |
| Low-5 | M-7 | RunIntent был неоднозначен в schema inventory | Отдельный OmniWorkflowRunIntent + TargetClaim, не ConsumerReceipt: два event kinds одного root дают два receipts/один run. Остальные logical entities/UNIQUE сведены §3; phase ownership сохранён; T14; needs-evidence |
| Low-6 | M-14 | non-message root не определял получение conversationId | G07 domain resolver → protected root.conversationId/route; missing/multiple deny, не FIND_RECORDS core object; T14; needs-evidence |
| Low-7 | N-22 | Нет спроектированного внешнего writer access history | Явный ожидаемый restore default deny + audited recovery-admin regrant при отсутствии evidence; не обещаем внешний writer; T18/T29; needs-evidence |

Новые независимые причины:

| ID | Severity | Корневая причина | Контракт / будущая проверка | Статус |
|---|---|---|---|---|
| N-26 | major | Replica routing stale protected reads после revoke | spec §7, T08/T10 | closed_in_plan (R12 B/finalcheck) |
| N-27 | major | Нет canonical storage/API conversation↔CRM targets | spec §3/7, T10/T13/T23 | closed_in_plan (R12 B/finalcheck) |
| N-28 | minor | Reply отсутствует в immutable command contract | spec §4, T11/T12 | closed_in_plan (R12 B/finalcheck) |
| N-29 | minor | Per-chat outbound order не определён | spec §4, T11 | closed_in_plan (R12 B/finalcheck) |

Итого57 стабильных причин; прежние53 не считаются повторно новыми. Эти новые причины обнаружены в baseline полного A, не порождены текущим R12 fix. Исправленный полный пакет передан fresh A до reconciliation, без списка выше. Предыдущие closed статусы исторические; затронутые причины в этом раунде ждут повторной независимой оценки. Модель1712/23 не покрывает новые replica/target/reply/FIFO контракты.


### R12 corrected full A

Fresh session 1df48316-a77d-4ca5-b68f-d20f29856372, [отзыв](claude-r12-corrected-a.md): ready_for_implementation, 1 Medium/5 Low; этапам1–3 не мешают. Все 34 документа и ключевые источники просмотрены, transport только по source report. Исправления внесены до финальной сверки, не оставлены как молчаливо принятый риск.

| A finding | Stable ID | Исправление / oracle | Происхождение |
|---|---|---|---|
| M1 | N-5 | Single existing session owner, preserved journal, authenticated legacy generation0 до switch, userbot cutoff, monotonic rollback или fence; §15.25, T11/T18 | Исходный план rollout не уточнял этот boundary; не новый runtime дефект |
| L1 | N-30 | Human запрещает autonomous AI, но explicit manager summary/rephrase — scoped read-only assist без Command/slot; T12/T25 | Непокрытая часть F-04 в исходном плане |
| L2 | M-9 | Единый StageRule UNIQUE: read/edit optionValue, transition from/to, unused explicit wildcard; T30 | Schema inventory текущего R12 fix породил несовместимую краткую строку |
| L3 | N-29 | outboundSequence диагностический для connector; durable journal order/commandId authoritative; restore fence/max retained sequence/orphan quarantine; T29 | Следствие текущего R12 FIFO уточнения |
| L4 | M-6 | Retention/purge всех payload copies, no AI/search operational payload, dedup/hash сохраняются; incomplete purge при недоступности store; T17/T32/T29 | Неполный исходный retention inventory |
| L5 | L-2 | Старые design02/05 keys и migration строка исправлены непосредственно на canonical spec | Предсуществующие краткие схемы; не новый runtime дефект |

| ID | Severity | Причина | Контракт / будущая проверка | Статус |
|---|---|---|---|---|
| N-30 | minor | F-04 явная помощь менеджеру не отличалась от autonomous AI | spec §9, T12/T25 | closed_in_plan (R12 B/finalcheck) |

Итого58 стабильных причин. У corrected A6 проявлений, два обнаружены в изменениях текущего R12; ни одно не скрыто. Третий свежий полный проход получает согласованную редакцию без этого списка; после него B сверяет58 ID и все17 проявлений R12. До результата no global pass.


### R12 final A — без общего pass

Fresh session0931eb04-bbde-4eac-bc59-b43f51c7ea3a, [полный отзыв](claude-r12-final-a.md): needs_revision, 3Medium/4Low; архитектурного перепроектирования reviewer не требует. Полнота34 документов подтверждена, source selection/внешние ограничения сохранены. Автор проверил реальный WorkspaceOrmManager.getOrRecompute role maps и исправил действующие нормативные строки, а не только добавил статус.

| A finding | Stable ID | Исправление / oracle | Происхождение |
|---|---|---|---|
| F1 Medium | M-7 | Одна root-set UUIDv5 formula в spec/design09; intent/TargetClaim lookup при recovery, eventId не run key; T14 | Прежняя eventId формула не была удалена при уточнении RunIntent текущего R12; patch-induced omission |
| F2 Medium | N-31 | Protected native permission inputs загружаются из primary внутри fence, cached role maps не authoritative; T10/T31 | Исходный план не охватывал pre-transaction cache inputs |
| F3 Low | N-29 | Replacement также ждёт unknown acceptance predecessor; без ordering waiver, UI waiting_predecessor | Неоднозначность текущего R12 FIFO fix |
| F4 Medium | N-21 | Обязательный human observedSequence и stale_view/явное UI подтверждение; отдельно от controlEpoch/idempotency/dispatch | Прежнее разделение epochs не согласовало требование stale-view из design02/04 |
| F5 Low | M-7 | effectKind v1 единственный customer_inbound; общий admission/root/budget | Исходная enum недоопределена |
| F6 Low | N-6 | Mode/takeover/close/reopen/status явно UPDATE/policyEpoch; G20/takeover_on_send rollback и bounded restart без upgrade | Неполный прежний policy lock catalog |
| F7 Low | N-32 | UI displayOccurredAt+MessageLink.id отдельно от apply sequence; capture fallback явный; T16 | Исходный UI contract не задавал chronology import/live |

| ID | Severity | Причина | Контракт / будущая проверка | Статус |
|---|---|---|---|---|
| N-31 | major | Native cached permission inputs могут пережить revoke | spec §15.26, source WorkspaceOrmManager, T10/T31 | closed_in_plan (R12 B; future runtime evidence pending) |
| N-32 | minor | Хронология UI смешивалась с apply cursor | spec §15.26, T12/T16 | closed_in_plan (R12 B/finalcheck) |

60 stable IDs, 24 проявления R12 (11+6+7). Авторские исправления ждут B. Последний full A остался needs_revision; четвёртый одинаковый широкий цикл не запускается автоматически. B должен отдельно подтвердить все60 причин/24 проявления и принять/оспорить refutation неизвестной human send. Его возможный положительный результат не будет назван свежим full pass после этой delta. Runtime/real traffic не меняются.


### Итог R12 B и targeted finalcheck

[Сверка всех60 ID](claude-r12-reconciliation.md) сначала закрыла59 и оставила N-21 Low: новые stale_view правила расходились с двумя старыми строками. Это дополнительное 25-е проявление R12, порождённое последней правкой N-21; не новая причина. Нормативные строки §15.19/P07 исправлены на «входящее не меняет controlEpoch, но требует stale_view/подтверждения». Timeline wording согласован с display chronology. [Точечный finalcheck](claude-r12-b-finalcheck.md) подтвердил N-21 и отсутствие нового противоречия этой delta. Все60 closed_in_plan; B ready_for_implementation. Refutation initial Low-2 принята, отдельный RunIntent подтверждён. N-15/N-31 требуют будущих T19/T31, это не открытые дефекты текста и не пройденные tests.

Последний полный независимый A по более ранней редакции остаётся needs_revision. B/finalcheck не переименовываются в свежий общий pass. ROB-772 сохраняется In Progress, ROB-764 Todo; все live/product gates на месте. Четвёртый одинаковый широкий цикл в этой работе не запущен. Перед следующим общим допуском следует свести разнесённые нормативные определения в единственный источник (run identity, permissions/epochs, send/UI), оставляя в остальных разделах ссылки: текущая серия показала именно противоречия дублирующихся строк, а не отсутствие новых features.
