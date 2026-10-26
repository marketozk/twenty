# Кроссревью подробного плана — реестр

**Итог R4: needs_revision / escalate. Из 46 причин 38 закрыты в плане, 8 открыты: 5 major и 3 minor. Допуска к реализации нет. Три раунда авторских правок выполнены; четвёртый требует явного решения владельца по cross-review-convergence. [Конкретный остаток и следующий пакет](residual.md).**

Объект: весь проект, requirements/design/phase_1–7 и implementation-spec.md. Baseline 475e2753. Режим: fix-and-recheck только документов, полный протокол. Нового runtime-кода/тестов/деплоя нет. User подтвердил весь проект. Оракулы этого review: source trace, consistency constraints, requirement→phase→test mapping. Будущие runtime tests не выдаются за пройденные.

R1: независимый Claude Code 2.1.296, reported model claude-opus-5-5, session 7279ea44-b0aa-4739-91c8-192b27f42e96. Read/Grep/Glob only, Bash/Edit/Write и slash skills отключены, MCP отключён; exit 0, is_error=false. [Полный ответ](claude-initial.md). Raw response хранится временно вне Git; секретов в отчёте нет. Автор проверил ключевые code findings и подготовил подробную спецификацию. Severity ниже нормализована по влиянию на будущий контракт.

## Findings

После R2 stage B: 20 исходных причин closed_in_plan, 7 открытых до второй правки. Closed относится только к контракту и тестовому плану. R2 исправления ниже подготовлены автором и ждут нового независимого прохода. Происхождение — исходный план; не текущий production defect. Failure scenarios внутри модели раздела 1; продуктовые gates не считаются выбранными пользователем.

| ID | Severity | Корневая причина | Контракт/проверка | Статус |
|---|---|---|---|---|
| H-1 | major | Таймлайн обходит conversation ACL | 15.1 / T21 | closed_in_plan (R4 B) |
| H-2 | major | Cleaner lifecycle удаляет историю | 15.1 / T22 | closed_in_plan (R4 B) |
| H-3 | major | Auto principal/read scope | 15.3 / T25 | closed_in_plan (R4 B) |
| H-4 | major | Повтор AI effect после crash | 15.3 / T26 | closed_in_plan (R4 B) |
| H-5 | major | Restore inbound/admission gap | 15.4 / T29 | closed_in_plan (R4 B) |
| H-6 | major | External outgoing без команды | 15.2 / T24 | closed_in_plan (R4 B) |
| M-1 | major | Dispatch recovery после takeover | 15.3 / T28 | closed_in_plan (R4 B) |
| M-2 | major | Cancel connector queued command | 15.3 / T28 | closed_in_plan (R4 B) |
| M-3 | major | SaleBot ID не доказан native | 15.2 / T16 | closed_in_plan (R4 B) |
| M-4 | major | MAX event variants vs logical identity | 15.2 / T01,T11 | closed_in_plan (R4 B) |
| M-5 | major | Person merge identity lifecycle | 15.2 / T23 | closed_in_plan (R4 B) |
| M-6 | minor | Message revision retention | 15.5 / T32, explicit gate | closed_in_plan (R4 B) |
| M-7 | minor | Canonical durable workflow trigger | 15.3 / T14 | open (R4 B) |
| M-8 | major | Audit DB owner privileges | 15.5 / T06 | closed_in_plan (R4 B) |
| M-9 | major | Stage SELECT vs nonexistent Stage ID | 15.5 / T30 | closed_in_plan (R4 B) |
| M-10 | minor | Test environment identity | 15.5 / test preflight | closed_in_plan (R4 B) |
| M-11 | major | Fork migrations before existing cursor | 15.5 / T33; source reader groups command kinds | closed_in_plan (R4 B) |
| M-12 | major | Unknown Person creation | 4 / T02,T05 | closed_in_plan (R4 B) |
| M-13 | major | Burst AI turns | 15.3 / T27 | closed_in_plan (R4 B) |
| M-14 | minor | Workflow send route selection | 15.3 / T14 | closed_in_plan (R4 B) |
| L-1 | minor | Audit writer phase cycle | 3 / T02,T06 | closed_in_plan (R4 B) |
| L-2 | minor | Stale status/spike in open questions | open-questions.md updated | open (R4 B) |
| L-3 | minor | Audit catalog volume | 15.5 / T19 | closed_in_plan (R4 B) |
| L-4 | minor | Binding identity on reconnect | 15.1 / T11 | closed_in_plan (R4 B) |
| L-5 | major | Native role changes bypass own fence | 15.5 / T31 | closed_in_plan (R4 B) |
| L-6 | major | Import actor revoke per batch | 15.5 / T10,T16 | closed_in_plan (R4 B) |
| L-7 | major | Generic mutation of Message | 15.1 / T22 | closed_in_plan (R4 B) |

## Журнал экземпляров

R1 содержит по одному проявлению каждой строки таблицы выше; source evidence и сценарии — в полном ответе Claude. Новые причины, исходный план, не порождены исправлением. Авторский source pass для M-11 дополнительно установил grouping fast/slow/workspace в UpgradeSequenceReaderService и startCursor после прошлого command; принят fork-only migration ledger, проверка этого нового orchestration обязательна на свежем review.

## Каналы и остаточные риски

Данные/конкуренция/авторизация/внешние эффекты/восстановление релевантны, каждому соответствует T01–T33. Сейчас меняются только документы. External runtime/source imports будут проверены заново по SHA перед переносом; тесты новых контрактов отсутствуют до реализации. Product gates — раздел 13 и 15.5. Ни один residual risk не принят за владельца. Candidate pass требует fresh full-object review, затем reconciliation всех ID.

## R2 — fresh A, затем reconciliation B

Claude session `4e9c1793-d8e3-4eb9-9659-5e985aad75e9`, claude-opus-5-5, is_error=false. [Blind A](claude-fresh.md), [сверка всех 27 ID](claude-reconciliation.md). A не читал registry/старый review; B выполнен только после сохранения A, через resume той же сессии. Snapshot A — review-manifest.json. A verdict needs_revision. Все runtime проверки будущие.

Повторы R2: H-2 ← A/H5,L18; H-6 ← A/H3; M-7 ← A/H1; M-8 ← A/H7; M-9 ← A/H4; M-10 ← A/H6; M-11 ← A/M14,H7 (startup). M-4 редакционное уточнение nativeMessageKey не открывает уже закрытый корень. Исправления второго раунда: §15.6–15.9, согласованы §2/3/7/15.5 и wire StageOptionsHash. Источники автора: EntityEventsToDbListener, pending-wake-up listener, generator, core account/channel cascade, Docker entrypoint, connector schema.sql и Telegram store.py. Никакой DB ownership/cutover/функции сейчас не изменены.

| Новый ID | Severity | Причина / R2 A | План и тест | Статус / происхождение |
|---|---|---|---|---|
| N-1 | major | Производные объекты и inheritance / H2 | §15.6, T08,T21, inventory до patch ROB-766 | open (R4 B) |
| N-2 | major | Невидимый unassigned queue / H9 | §15.6 QueueGrant, activation gate, T12 | closed_in_plan (R4 B) |
| N-3 | major | Pausing AI занимает turn / M10 | §15.9, T27 | closed_in_plan (R4 B) |
| N-4 | major | Instance-admin export/impersonation / M11 | §15.6, T07,T08 | closed_in_plan (R4 B) |
| N-5 | major | Connector journal/owner/cancel границы / M13 | §15.7, T11,T28, deployment gate | closed_in_plan (R4 B) |
| N-6 | major | Lock ordering только takeover / M12 | §15.9, T02,T10,T23,T28 | closed_in_plan (R4 B) |
| N-7 | major | Generation cutover replay / H8 | §15.7, T11,T18 | closed_in_plan (R4 B) |
| N-8a | minor | Хранилище поиска / L15 | §15.9, T12,T17,T19 | closed_in_plan (R4 B) |
| N-8b | minor | Автор зависит от mutable participant / L16 | §15.7, T24 | closed_in_plan (R4 B) |
| N-8c | minor | API-key principal fixture / L17 | §15.6, T08 | closed_in_plan (R4 B) |

R2 уточнение экземпляров старых причин: H-6 (классификация без correlation) и M-9 (global metadataVersion) порождены первой правкой; M-10 (synthetic workspace assumption) и M-11 (generator registration) также уточнения первой правки. H-2/M-7/M-8 — неполное исправление baseline. Не скрываются как новые независимые ID. Всего 17 незакрытых причин после reconciliation: 7 повторов + 10 новых, из них 5 проявлений порождены правкой; снижение против исходных 27. Требуется fresh полный проход после второй правки, затем B; no pass по утверждению автора.

## R3 — второй fix-and-recheck

Fresh Claude session `6d0fc063-434c-4708-a96e-aba061cd00b2`, is_error=false. [A](claude-r3-fresh.md), [B](claude-r3-reconciliation.md), review-r3-manifest.json. 35/37 прежних причин закрыты в плане; M-7 остался open, L-2 needs_evidence потому что reviewer не перечитал open-questions (не новая регрессия). Четыре новые причины ниже. Число открытых major уменьшилось с 13 до 4. Третий авторский fix: §15.10–15.11, корректировка phase_1/phase_5/API/ключей схемы и ранней Revision migration; обязательный следующий fresh review проверяет весь объект, затем reconciliation. Runtime tests по-прежнему не выполнены.

| Новый ID | Severity | Причина | Fix / будущий oracle | Статус |
|---|---|---|---|---|
| N-9 | major | Mapping omni key в global headerMessageId helper + placeholder no-op | §15.10, T01,T17, namespace collision/revision | closed_in_plan (R4 B) |
| N-10 | major | Manager composer send vs active auto без takeover | §15.11 managerReplyPolicy activation gate, T13,T24 | closed_in_plan (R4 B) |
| N-11 | major | Ownership transfer архивирует общий канал | §15.11 WORKSPACE/custodian domain transfer, T22,T31 | closed_in_plan (R4 B) |
| N-12 | minor | Импорт не сохраняет исторического автора | §15.11 source provenance+explicit mapping, T16 | closed_in_plan (R4 B) |

Повтор M-7 в R3: два проявления — отсутствие исполнимой typed workflow projection и неявное suppression helpers. Первое baseline, второе выявлено на границе уточнения R2. Самопроверка автора подтвердила WorkspaceTransactionScope.getRepository options, workspace-wide header query, optional workflowRunId runner и transferOwnership archive/isSyncEnabled mutations. Третья правка выбирает concrete wrapper и typed trigger, не требует переписывания email pipeline. R4 — проверка третьего fix, не разрешение четвёртой правки при новом существенном остатке.

## R4 — третий fix-and-recheck, итог без pass

Fresh session `82f878e4-8885-42d6-ba1f-266a2c9bb2e4`, is_error=false, claude-opus-5-5. [Blind A](claude-r4-fresh.md), [reconciliation B](claude-r4-reconciliation.md), review-r4-manifest.json. Все 41 прежних ID проверены: 38 closed_in_plan, N-1 major reopened, M-7 minor open (основной trigger контракт закрыт, остаётся hard throttle), L-2 minor open (исходная устаревшая версия исправлена, теперь неполный свод gates). Добавлены пять новых причин. Source-specific ключевые утверждения автор проверил по build-row-access-policy/build-record-share-gate и standard-object-readability fixture; это не live evidence.

| Новый ID | Severity | Причина | Проверка/следующая правка | Статус / origin |
|---|---|---|---|---|
| N-13 | major | Неполный inventory Enterprise-marked imports в общем ORM пути; независимость own ACL не доказана | Source fact отдельно от прав использования; license text/dependency boundary + T20 PRIVATE/INHERITED | open; baseline; юридический вывод needs_evidence |
| N-14 | major | Workflow send после takeover получает новый epoch | Матрица sender×mode, AI workflow provenance, T13/T24 | open; baseline, конкретизирован R3 |
| N-15 | major | Epoch mismatch/lock mode не определены | Reauthorize vs reject; SHARE/UPDATE без upgrade, T10 | open; порождён уточнением R2 |
| N-16 | major | Нет pull transport для native/archive import | Источник страниц/контракт/auth/cursor; убрать внешний origin, T11/T16 | open; baseline, противоречие усилено R1 |
| N-17 | minor | Opportunity.expectedRevision не имеет источника | Выбрать CAS token и T30 | open; порождён уточнением R2 |

Число open major по независимым сверкам: R1=20; R2=13; R3=4; R4=5. Total causes: 27→37→41→46. R2: 10 новых причин/7 существенных повторов; R3: 4 новых/2 старых незакрытых; R4: 5 новых/3 повторно открытых. В R4 минимум 4 проявления явно порождены уточнениями (N-15,N-17,M-7,L-2), остальные baseline/раскрытые интеграцией. Ни одно не принято как допустимый риск. Повышение числа major и достигнутый потолок третьего fix требуют остановки перед четвёртой правкой и конкретного решения владельца, не продолжения до желаемого pass.

Авторский итог: `escalate` с [листом остатка](residual.md), не готово к ROB-764. Нельзя принять молчаливую необратимую утечку N-1 или неавторизованную отправку N-14 как harmless residual. Остальные также open до исправления/доказательства; стоимость следующего шага — конкретные исправления контрактов и новый независимый полный pass, без runtime/deploy. Схема, контракты и 33 группы тестов подготовлены, но общий план не закрыт.

Уточнение к последней фразе Claude B о карточке: reviewer не имел MCP и не менял Linear; утверждение о наличии вопроса в карточке не подтверждено. Автор создал только ROB-772 с объёмом/критериями, без вопроса о покупке или разрешении нарушать лицензию. Решение D-18 сохраняется. Отсутствие key-check не доказывает права использования или нарушение; ничего из этого не объявляется установленным.
