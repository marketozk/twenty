# Журнал разработки Twenty CRM

Здесь фиксируем фактически выполненную работу. [План](plan/README.md) описывает будущие шаги; [Linear](https://linear.app/robotrts/project/twenty-crm-obshenie-s-klientami-eccda8a60c7b) — актуальные задачи, статусы и зависимости. [Карта задач](linear.md) связывает их с документами. Аудит действий пользователей внутри CRM — отдельная разрабатываемая функция, описанная в [design/08-audit.md](design/08-audit.md).

## Правила ведения

1. Перед работой прочитать последнюю запись, документ этапа и задачу Linear. Переводить задачу в In Progress только при фактическом начале её выполнения.
2. После каждого законченного рабочего шага или остановки добавить запись ниже: результат, файлы, проверки, ссылки на коммиты/PR, ограничения и следующий шаг. Записывать также неудачные проверки и блокировки. Не переписывать старые записи под новый результат: добавлять уточнение.
3. Обновлять журнал в том же коммите, что и соответствующую работу; SHA этого коммита находится в Git history файла. Ссылки на уже существующие коммиты указывать явно. После push — краткий отчёт со ссылкой на коммит и запись журнала в задаче Linear. Это часть работы по задаче, а не отдельная фоновая автоматизация.
4. Linear — источник актуального статуса; документы Git — подробные решения и доказательства. Если Linear недоступен, сохранить запись с пометкой «синхронизация ожидает»; при следующем доступе проверить существующие комментарии и отправить только отсутствующий отчёт.
5. Done — выполнены критерии задачи и зафиксированы проверки. Для документации достаточно её проверки; это не означает сборку приложения. Реализация, тестирование, деплой и клиентская приёмка всегда различаются. Отдельный PR/деплой отмечается отдельной записью.
6. Не хранить пароли, токены, сессии, дампы, клиентскую переписку и сырые логи с личными данными. Артефакты проверок очищать; подробные отчёты размещать в `implementation/` и ссылаться на них, не копировать весь вывод команд.

### Шаблон записи

```markdown
### YYYY-MM-DD HH:mm MSK — LOG-NNN — краткий результат
- Задача / этап: ссылка Linear и файл плана.
- Статус: выполнен шаг / частично / заблокировано; состояние всей задачи отдельно.
- Сделано: конкретные изменения и затронутые файлы.
- Проверка: команда или сценарий → фактический результат; что не проверено.
- Git / артефакты: существующий SHA/PR/отчёт; текущая запись входит в коммит работы.
- Среда / деплой: где проверено; выполнялся ли выкат.
- Ограничения / решения: оставшиеся вопросы и причины отклонений от плана.
- Далее: один конкретный следующий шаг.
- Linear: отчёт отправлен / синхронизация ожидает.
```

## Записи

### 2026-10-26 12:45 MSK — LOG-003 — принят новый порядок, начаты пункты 1–5

- ROB-763: в работе. Пользователь разрешил обновление одного экземпляра без новой резервной копии, затем исследование кода и уточнение плана. [Порядок](plan/current-steps.md) заменяет отдельный постоянный стенд и выбрасываемые прототипы.
- Исходное состояние: чистый checkout `1638029f`; server/worker официальной 2.51.0. GitHub latest — 2.51.0; сохраняем согласованный снимок исходников 2.52 `729f6236`, без смешивания с новым main.
- Preflight: около 107 GiB available RAM и 1.3 TiB свободного диска; server healthy. Это не результат обновления.
- Далее: сборка полного коммита, чтение кода и миграций. Новый backup и второй экземпляр не создаются, данные не сбрасываются.
- Linear: статус и порядок синхронизируются в ROB-763.

### 2026-10-26 — LOG-001 — исходное состояние перед началом журнала

Запись восстановлена по текущим документам и Git; это не утверждение о выполнении всех действий в момент создания журнала.

- Задача: [ROB-762](https://linear.app/robotrts/issue/ROB-762), проектирование — Done.
- Сделано: требования v0.6, архитектура, восемь этапов плана и отдельный аудит. Исключены тендерный робот и подписка Twenty. Исправлены замечания ревью по takeover и import/live.
- Доказательства: `2f642721` — исключение робота; `bb1b8fa6` — архитектура; `8b2657ff` — собственные права без подписки; [1381911d](https://github.com/marketozk/twenty/commit/1381911d) — план и аудит; [ревью](review.md).
- Проверка ранее: 64 локальные ссылки без пропусков, `git diff --check`, два независимых ревью и повторная проверка замечаний. Эти результаты описаны в предыдущей работе; runtime-тесты и сборка доработки не выполнялись.
- Среда: исходники закреплены на снимке 2.52; демо официальной 2.51 отдельно. Обновление демо описано в [отчёте](../twenty_upgrade_2_51/report.md) и не означает реализацию омниканальной CRM.
- Далее: [ROB-763](https://linear.app/robotrts/issue/ROB-763), среда разработки и транзакционные проверки.
- Linear: задача создана с доказательствами и статусом Done; runtime-задачи не завершены.

### 2026-10-26 12:06 MSK — LOG-002 — учёт разработки в Git и Linear

- Сделано: создан отдельный проект Linear «Twenty CRM — общение с клиентами», 10 задач ROB-762–ROB-771 и 19 связей зависимостей. Аудит разделён на сбор событий (2a) и защищённый просмотр (2b), чтобы не создавать цикл с правами доступа.
- Статусы при создании: ROB-762 Done; ROB-763 Todo; ROB-764–ROB-771 Backlog. Подготовка среды ещё не начата. Даты и исполнители не выдумывались.
- Документы: этот журнал, [карта Linear](linear.md), ссылки в PROJECT/плане и правило ведения в CLAUDE.md.
- Доступ: подключение приложения Linear вернуло UNAUTHORIZED; локальный API подтвердил доступ. Ключ использован из Windows Credential Manager, в документы не записывался.
- Проверка: API подтвердил 10 задач, 19 связей и ожидаемые статусы при обратном чтении; проект Planned. Все 49 локальных ссылок в пяти изменённых документах существуют; `git diff --check` прошёл. Тесты приложения не запускались — изменён только учёт разработки.
- Исправленные сбои проверки: большой вложенный GraphQL-запрос отклонён как Query too complex; уменьшены размеры страниц с проверкой hasNextPage. Относительные ссылки в описаниях заменены ссылками GitHub; учтено, что Linear возвращает URL в угловых скобках. Повторное чтение подтвердило исправления без создания дублей.
- Среда / деплой: изменены документы и проект Linear; код приложения и работающие сервисы не менялись.
- Далее: выполнять ROB-763 по этапу 0; писать очередной отчёт после каждого проверяемого шага.
- Linear: задачи созданы; итоговый отчёт этой записи отправляется после push. История коммитов файла содержит точную ревизию записи.

### 2026-10-26 — LOG-004 — пункты 1–5 выполнены

- Задача: [ROB-763](https://linear.app/robotrts/issue/ROB-763). Завершены сборка, обновление единственного экземпляра, исследование исходников и уточнение плана. Новые функции в этот объём не входят.
- Версия: опубликованный latest — 2.51.0; по принятому решению собран закреплённый снимок разработки 2.52. Источник образа [44e1449c](https://github.com/marketozk/twenty/commit/44e1449c); скрипт выката [0ec3fa9c](https://github.com/marketozk/twenty/commit/0ec3fa9c). Полные SHA, image ID, build и migration evidence — [отчёт](implementation/version-and-deploy.md).
- Деплой: server/worker существующего twenty-demo заменены нашим образом. Новая резервная копия не создавалась по просьбе пользователя; данные, конфиги, DB/Redis и другие сервисы сохранены. До stop исправлено замечание независимого ревью о сверке фактического runtime с Compose.
- Проверка: build exit 0; upgrade status instance/workspace up to date, 0 failed; семь count/content fingerprints равны до/после; локальный и серверный health 200; оба процесса без рестартов. В браузере после reload открываются обзор с 6 тендерами, доска с 6 сделками, два процесса и схема Quick Lead. Workflow и внешние отправки не запускались.
- Исследование: [транзакции/аудит](implementation/transactions-audit-source.md), [права](implementation/access-source.md), [ИИ/workflow](implementation/ai-workflow-source.md). Составлены [карта реализации](implementation/integration-map.md) и [лицензионный инвентарь](implementation/license-inventory.md). Выбраны служебные core-таблицы в той же БД, с workspaceId, без autogenerated CRUD; записи выполняются executor текущей транзакции.
- Обновлены PROJECT, действующий этап 0, архитектура, модели, поведение, проверки и планы 1/2/3/5. Статическое исследование подтвердило места изменения, но не доказывает ещё не написанные ACL/audit/fence. Их rollback/race/revoke/import/email тесты остаются обязательными при реализации.
- Сбои: ранняя сверка неполного SCP отказала до извлечения; после полного transfer hash совпал. Приложение не затронуто этим отказом. Встроенный коннектор Linear недоступен; используется подтверждённый локальный API без записи ключа в файлы.
- Повторное независимое ревью: существенных противоречий core storage/shared executor не найдено; исправлен устаревший статус 2.51/предстоящей сборки в roadmap.
- Проверка документов: 157 локальных Markdown-ссылок существуют; синтаксис deploy-fork.py проверен через ast.parse; git diff --check без ошибок.
- Далее: ROB-764 — модель, receipt/link/admission/outbox и единая транзакционная запись. Разработка следующего этапа в этой записи не заявляется.
- Linear: после push этой записи синхронизировать описания, ROB-763 Done, ROB-764 Todo и отчёт с commit; проверка обратным чтением обязательна. Результат синхронизации фиксируется комментарием задачи.

### 2026-10-26 — LOG-005 — итоговая синхронизация и проверка

- Публикация LOG-004: commit `1b0952a895b3960643c3f48b14462cff72089340` отправлен в origin. [Отчёт Linear](https://linear.app/robotrts/issue/ROB-763/0-obnovit-ekzemplyar-forkom-252-i-zavershit-issledovanie-koda#comment-b4d0347c).
- Обратное чтение API подтвердило: проект In Progress; ROB-762/763 Done, ROB-764 Todo, остальные семь Backlog. Все девять описаний этапов обновлены, 19 зависимостей сохранены, отчёт LOG-004 ровно один. Новый этап не начат.
- Созданный для этой сборки BuildKit остановлен, cache сохранён. После остановки server healthy и worker running на нашем образе, у обоих restartCount 0; health HTTP 200 на сервере и через localhost:2020.
- Сборка/выкат остаются из `44e1449c`; коммиты отчётов не меняют runtime. Следующее действие — реализация ROB-764 по обновлённому плану.

### 2026-10-26 — LOG-006 — подробный план всего проекта и кроссревью Claude Code

- Задача: [ROB-772](https://linear.app/robotrts/issue/ROB-772), подтверждение пользователя «Весь проект подробно». Runtime-код, деплой, сообщения, импорт и переключение SaleBot не входят.
- Подготовлены [implementation-spec](plan/implementation-spec.md) для всех этапов, [покрытие требований](plan/coverage.md) и [реестр кроссревью](plan/cross-review/registry.md). Схемы, транзакции, API, ACL, audit, UI, connector/userbot, ИИ/workflow, импорт/media, migration/recovery/cutover и 33 группы будущих тестов описаны вместе с продуктовыми gates.
- Независимый reviewer: Claude Code CLI 2.1.296, фактически сообщённая модель claude-opus-5-5. Только Read/Grep/Glob, без Bash/Edit/Write/MCP/hooks/slash skills. Полные ответы и session IDs сохранены в реестре. Это review документов по исходникам, не выполненные runtime tests.
- R1: 27 причин; автор уточнил контракты. R2 fresh blind A + reconciliation B: 20 исходных причин закрыты в плане, 7 требуют уточнений, 10 новых причин после разделения составных. Вторая правка устраняет документальные пробелы; её независимый результат фиксируется ниже/в реестре, авторская запись не считается pass.
- Source evidence: общий event listener вызывает webhook/logic function/agent triggers; generator автоматически регистрирует migration; FK cascade account/channel; entrypoint продолжает после upgrade failure; connector schema и userbot journal. Обновлены suppression/derived ACL/echo correlation/migration orchestration/audit schema/connector contracts. [215 bypass-кандидатов в 106 файлах](implementation/bypass-candidates.md) — обязательный inventory для дальнейшей классификации ROB-766, не список доказанных уязвимостей.
- Изменены только документы. Посторонний репозиторий робота, исходники транспорта и работающий Twenty не изменялись. Тесты новых функций отсутствуют и не запускались.
- Linear: отдельная ROB-772 создана In Progress и блокирует ROB-764; статусы реализации не повышались. Публикация документов и итоговая синхронизация выполняются после проверки.

- Итог независимых проходов: R3 закрыл 35/37 прежних причин, добавил 4; R4 после третьей правки закрыл 38/41 прежних, добавил 5. Всего 46 причин, 38 closed_in_plan, 5 major и 3 minor open. Последний verdict needs_revision; авторский escalate, pass не заявлен. [Конкретный остаток](plan/cross-review/residual.md) включает производные AI/workflow данные, лицензированные импорты, workflow send vs takeover, epoch/locks, history pull, throttle, свод gates и CAS сделки.
- По cross-review-convergence остановка перед четвёртым fix-and-recheck, требующим явного решения владельца. Открытые риски не приняты за пользователя. ROB-772 остаётся In Progress, ROB-764 Todo и заблокирована ею. Текущая работа сохраняет план и evidence даже без положительного допуска реализации.
- Проверка перед публикацией: 247 локальных Markdown-ссылок существуют, JSON manifests валидны, реестр содержит ровно 46 уникальных причин / 38 closed / 8 open, git diff --check без ошибок; diff runtime-каталогов пуст. Проверки документации не означают прохождение T01–T33. Commit этой записи и push фиксируют весь review-пакет; итоговый отчёт Linear с точным SHA публикуется после push.

### 2026-10-26 — LOG-007 — опубликован пакет плана и проверена синхронизация

- Git: `23a059d51e326d0bf4e71ba709bba2d142e9a087` отправлен в origin/codex/omnichannel-requirements; 36 файлов документации, без runtime изменений. Репозиторий после push чист, расхождение HEAD/origin 0/0.
- Linear: восемь описаний ROB-764–771 дополнены подробным контрактом и открытым остатком; ROB-772 содержит весь scope и needs_revision. Обратное чтение подтвердило 11 задач, ROB-772 In Progress, ROB-764 Todo, семь этапов Backlog и связь ROB-772 blocks ROB-764. [Итоговый комментарий](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-654c7ac4) ровно один.
- Все завершённые CLI-проходы exit 0/is_error=false; свежие R2/R3/R4 и последняя сверка сообщают claude-opus-5-5. Это подтверждение исполнения review, не положительного вердикта: needs_revision сохраняется.
- Следующее действие: явное решение владельца о четвёртом пакете правок плана по листу остатка. Никаких accepted-risk, runtime/deploy или отправок клиентам этой синхронизацией не добавлено.

### 2026-10-26 — LOG-008 — четвёртый раунд разрешён и выполнена авторская правка

- Пользователь разрешил продолжение ответом «да продолжаем». ROB-772, только документы. Baseline `96ddf21e`, runtime исходники неизменны.
- Исправлены контракты восьми остатков R4: защищённые artifacts AI/workflow, независимый baseline ACL/dependency inventory, sender×mode после takeover, policy reauthorize и SHARE/UPDATE без upgrade, pull history pages, terminal workflow throttle, единый реестр G01–G18, core revision для CAS сделки. API/phase3/5/6/open-questions/license inventory согласованы.
- Прочитаны pinned LICENSE, CoreWorkflowRunnerService (FAILED hard throttle), BaseWorkspaceEntity/Opportunity (revision отсутствует), recorder и actual native history bounds (24h; request limit≤100, MAX effective≤30). Никаких запросов истории/отправок/изменений БД не было.
- Начат fresh blind R5 через Claude Code default model, Read/Grep/Glob, без Bash/Edit/Write/MCP/hooks/slash skills. Snapshot review-r5-manifest.json. Вердикт ещё не предполагается; прежние open ID сохраняются до независимой сверки.

- R5/R6/R7 выполнены последовательно в пределах разрешённого продолжения: open major 1→1→2, итог R7 45/49 closed_in_plan, два major и два minor open. Все ответы A/B и manifest сохранены. Следующий круг той же формы остановлен по правилу сходимости; подготовлено конкретное предложение структурно пересобрать capability boundary/admission/reply budget. Оно не считается внесённой архитектурой или pass.
- R7 закрыл собственные baseline/event consumers, account metadata, rematch, workflow action wiring, trigger lifecycle/recovery и control CAS; вновь выявлены delegated token boundary и version-based replay, уточнены общий budget и pausing tools. Полный остаток — plan/cross-review/residual.md. ROB-772 остаётся In Progress, ROB-764 не начата.
- Исправление точности отчёта: raw CLI audit показал служебный mcp__task-card__update в R5 (3) и R6 (1), несмотря на prompt/strict-mcp-config. Это карточка CLI, не Linear; вызовов Bash/Edit/Write/Linear не было. В R7 tool явно запрещён; фактический аудит прилагается. Секреты/сырые диалоги CLI не публикуются.
- Работали только с документами Twenty CRM; пакеты runtime, ops и чужой репозиторий не менялись, реальные сообщения не отправлялись. T01–T33 остаются будущими проверками. Проверка, commit/push и синхронизация Linear фиксируются при публикации ниже.

- Проверка пакета LOG-008: 267 локальных Markdown-ссылок существуют; JSON валидны; снимок R7 не изменён после review; 49 уникальных ID / 45 closed / 4 open подтверждены механически. git diff --check и отсутствие runtime diff проверяются перед commit.

### 2026-10-26 — LOG-009 — опубликованы продолжение review и структурный остаток

- Commit `67f93ee2cc00a89339e96e63dc8c9f38baa8c7ae` отправлен в origin/codex/omnichannel-requirements: 30 файлов документов, без runtime/ops изменений. Пакет LOG-008 сохраняет R5–R7, четыре open причины и конкретное предложение structural redesign.
- Linear: свежим обратным чтением проверены все девять обновлённых описаний ROB-764–772 и точный SHA; ROB-772 In Progress, ROB-764 Todo, ROB-765–771 Backlog. Связь ROB-772 blocks ROB-764 сохранена. [Отчёт](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-2d6e756b) существует ровно один. Исторические краткие описания имеют явную ссылку на актуальный spec/остаток.
- Никакого pass, закрытия ROB-772 или старта ROB-764 не заявлено. Следующий review того же вида не запускается: требуется структурная переработка блока автоматизации по подготовленному предложению и новая проверяемая модель инвариантов.

### 2026-10-26 — LOG-010 — сводка и явный порядок продолжения

- По просьбе пользователя сверены файлы и свежие статусы/описания Linear. Итог R7 уже отражён в LOG-008/009, PROJECT, реестре и ROB-772; забытых закрытий или скрытого старта реализации нет.
- Добавлен STATUS.md: выполненное, нереализованное, четыре причины, порядок ROB-772 → ROB-764 → остальные этапы. PROJECT и linear.md ссылаются на сводку; устаревшее вступление roadmap исправлено — обновление версии уже завершено.
- Ближайшие действия оформляются checklist внутри существующей ROB-772: source matrix, согласование общей модели, таблицы сценариев, целевой и полный review. ROB-764 получает явный критерий старта. Новые дубли задач, изменения архитектуры и runtime в этой сводке не выполняются.
- Проверка ограничена документами и API учёта задач. Живой Twenty не перепроверялся; сохранённый отчёт обновления не выдан за новую runtime-проверку. Публикация и обратная сверка Linear фиксируются после push.

- Публикация LOG-010: commit `2945849029dd0564df42b690255fa01fb1589cab` отправлен в origin; проверены 78 локальных ссылок и diff --check. В Linear обновлены checklist ROB-772 и условие старта ROB-764; обратное чтение подтвердило по одному блоку, прежние статусы и связь blocks. [Отчёт](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-f6b8e62d) существует ровно один.

### 2026-10-26 — LOG-011 — актуализация документов и внесение последних правок в основной план

- Пользователь попросил проверить все документы/задачи и объяснить, вносятся ли review findings в план, какие skills реально использовались. Проверен корпус Research/omnichannel_crm, PROJECT/CLAUDE/SKILLS и все 11 задач проекта Linear; подробный индекс — DOCUMENT-AUDIT.md.
- Раньше R1–R7 меняли основной spec, но последние четыре причины были оставлены proposal. Сейчас H-3/M-7/N-3/M-13 внесены в основной план: closed tool policy/delegation, full pausing union/runner, stable workflowId + atomic dispatch snapshot, общий reply budget. Новый design/09 и source matrix объединяют модель; связанные §3/5/9/15, API/design/phase1/5/coverage согласованы. Авторский статус addressed_pending_review, не независимый closed/pass.
- Исправлены устаревшие текущие статусы и ссылки; датированные source reports явно отделены от нормативного плана. Исходные отзывы Claude и manifests R1–R7 сохранены, их доказательства не выданы за проверки новой редакции.
- SKILLS-AUDIT.md различает подтверждённые процедуры, историческое упоминание и отсутствие доказательства выполнения. System-design применён сейчас для DFD/таблицы границ. Не заявляем все пять фаз ai-dev-workflow или прохождение plan-eng-review/ui-design-workflow; ограничения CLI tools отражены честно.
- В этой работе новый blind review не запускался: сначала исправлен документ согласно запросу. Далее нужен целевой разбор новой модели и независимая проверка. Код/БД/сервисы/клиентские сообщения не менялись; tests T01–T33 будущие. Commit/push и Linear synchronization фиксируются после проверки.

- Проверка LOG-011 до публикации: 414 локальных Markdown-ссылок разрешаются; JSON валидны; 49 уникальных ID / 45 historical closed / 4 addressed_pending_review; 14 source SHA256 совпадают. Raw review/manifests и runtime/ops не менялись; git diff --check пройден. Это проверки документов и исходников, не runtime-тесты.

- Публикация LOG-011: commit `ceda4f6ec33657e0e3b26eb361440ff0659a450f` отправлен в origin/codex/omnichannel-requirements. Все 11 описаний ROB-762–772 обновлены; обратное чтение подтвердило текст после стандартной нормализации Markdown Linear (угловые скобки ссылок, bullets, checkbox case), прежние статусы и связь ROB-772 blocks ROB-764. [Отчёт](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-da9b6a34) подтверждён ровно один. ROB-762/763 сохраняют исторический Done; ROB-772 In Progress, ROB-764 Todo, остальные Backlog. Нового независимого verdict нет.

### 2026-10-26 — LOG-012 — независимая проверка исправленной модели

- Пользователь разрешил целевую проверку и полное ревью. Применены cross-review-convergence и read-only Claude CLI с неизменными auth/model; reported claude-opus-5-5. Внешние сервисы/сообщения и runtime не меняются.
- Targeted R8 обнаружил непокрытые workflow/native-tool/pausing/Retry paths и burst liveness/descendant semantics. Все замечания сверены с исходниками, внесены в основной план, API и source matrix; 7 проявлений сведены к четырём существующим ID, история не затёрта.
- Вместо новой автоматической пересборки burst принято fail-closed завершение с durable handoff: не терять unresolved входящие и не расширять retry поверхность. Следом — свежий полный review и reconciliation; результата пока нет.

- Итог LOG-012: targeted + R8/R9/R10 fresh A и последующие B выполнены; модель claude-opus-5-5, все CLI вызовы только Read/Grep/Glob. Все53 известные причины независимо closed_in_plan, open0. Каждый полный A был needs_revision; последний набор правок подтверждён B, но свежего полного pass после него нет. ROB-772 оставлена In Progress, ROB-764 не начата.
- Существенные правки внесены в действующий план, не только реестр: закрытые tools/actions; все governed triggers/roots/catalog; общий reply quota только с Command commit; epochs/mode/closed; lifecycle merge/destroy; restore auth/encryption; notes/attachments. Reviewer reports/manifests сохранены, старые raw R1–R7 не менялись.
- Дальше конечный контроль таблиц roots/catalog/permissions/Command lifecycle для допуска; runtime доказательства будут в реализации. Без нового автоматического широкого круга, без принятия риска за владельца. Проверки документов, публикация и синхронизация Linear ниже.

- Проверки LOG-012 перед публикацией: 454 локальных Markdown-ссылок без пропусков; JSON валидны; 53 уникальных ID/53 closed_in_plan; SHA256 всех 37 source файлов совпадают. Diff --check пройден; runtime/ops и исходные raw R1–R7 не менялись. Эти механические проверки не являются fresh full pass или тестами приложения.

- Публикация LOG-012: commit `621ebe66f328527d5f97bf32c1ae7e90967edfd1` отправлен в origin/codex/omnichannel-requirements (42 файла). API read-back подтвердил все11 описаний после стандартной Markdown-нормализации, прежние статусы и ROB-772 blocks ROB-764. [Отчёт](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-7dc64c45) существует ровно один. ROB-772 не помечена Done; ROB-764 не начата. Последняя запись фиксирует именно публикацию, не новый review/runtime result.

### 2026-10-26 — LOG-013 — конечные таблицы событий, прав и команд

- Пользователь разрешил конечную проверку до допуска реализации. Baseline c1a6100d, только Research/PROJECT; без новых runtime функций, БД/сервисов/реальных отправок. Применены cross-review-convergence (таблица решений, negative controls, fresh A отдельно от B), claude consult и transparent integration, linear-api.
- Сведены E01–E14, P01–P12, sender×mode и C01–C18. Автор нашёл пропуск accepted в pending_human_commands и противоречивое обещание close без remote cancellation proof; исправлены сами spec/API, а не только список находок.
- Fresh bounded R11 A (claude-opus-5-5) нашёл три major проявления M-7: core/legacy IDs, coverage reference при empty/ordinary catalog и explicit cancellation после publish. Source verified: CachedWorkflowAutomatedTrigger, listener enqueue, CoreWorkflowLifecycle publish/deactivate. Исправлены основной spec, design/09, API, schema и таблицы; отдельный fresh bounded A проверяет новую редакцию.
- Абстрактная модель расширена по замечаниям: 834 случая, 20 фактически обнаруженных negative controls. Guards — executable specification, не независимое доказательство runtime; модели DB/locks/full producer coverage/Message uniqueness/Attachment XOR здесь нет. T01–T33 всё ещё будущие tests. Source hashes расширены с37 до40; старый A artifact восстановлен из read-only tool output с точным совпадением всех3 hashes.
- Итог независимой сверки, публикация и Linear read-back фиксируются ниже после завершения.

- Итог LOG-013: оба bounded fresh A обнаружили3 major; все внесены в действующие контракты. B подтвердил bounded_tables_ready по delta и closed_in_plan пяти переоткрытых ID, не пересматривая остальные48; всего53 известных причин closed. Уточнены Command cancellation lineage и API, scope человека, late terminal ACK и пределы модели. Финальный прогон1712/23, runtime tests не запускались.
- Вторая A-сессия раскрыла случайное попадание старых строк через Grep; не считаем её чистым blind full pass. Третий одинаковый круг не запускается. ROB-772 остаётся In Progress, ROB-764 Todo. Следующий общий review должен получать изолированный технический пакет без архива findings; текущая работа завершает конкретную таблицу, не общий gate.

- Проверка LOG-013 перед публикацией: 500 локальных ссылок без пропусков, JSON валидны,40 source hashes совпадают,53 уникальных ID/53 closed_in_plan; модель1712/23 повторно выполнена. Diff --check пройден, runtime/ops diff отсутствует. [Результат](plan/cross-review/verification-r11.json).

- Публикация LOG-013: commit `24bd66cd3d2414622e2dc362b79198fa5a93cdd5` отправлен в origin/codex/omnichannel-requirements (32 файла). Все11 описаний Linear обновлены; API read-back подтвердил нормализованный Markdown, прежние статусы и ROB-772 blocks ROB-764. [Отчёт](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-baf07d66) подтверждён ровно один. Эта запись фиксирует публикацию и синхронизацию, не новый review verdict.

### 2026-10-26 — LOG-014 — итоговый полный review из изолированного пакета

- Пользователь разрешил продолжение после R11. Baseline c030e2e4; один полный fresh A всей спецификации, затем отдельная reconciliation. Применяются cross-review-convergence, Claude consult/transparent integration и linear-api. Новые runtime функции, DB/deploy/реальные сообщения не выполняются этим шагом.
- Подготовлен отдельный allowlist packet:34 технических документа,31441 tracked source/config/test file (~108MiB), без .git, журнала/статусов/архива review и автоматических CLAUDE/AGENTS/SKILL файлов. Нейтрализованы70 редакционных ссылок/маркеров; технические контракты сохранены, преобразования и SHA256 записаны в review-r12-a-packet-manifest.json. Проверены34 document hashes и40 source hashes. Reviewer работает только внутри packet.
- Свежий Linear read подтверждает ROB-772 In Progress, ROB-764 Todo, остальные статусы прежние. Итоговый verdict пока неизвестен; результаты и публикация фиксируются ниже.

- LOG-014 промежуточный результат: R12 fresh full A (eb7d40b6-b4b8-4d7a-ae49-e9336ecea98a) — ready_for_implementation с4Medium/7Low. Исправления внесены в spec и API/schema/этапы: primary protected reads, canonical targets, provenance сторонних отправителей, ранний contention gate, reply/FIFO, отдельный RunIntent, trusted workflow target, restore default deny. Waiver unknown human send не принят; контрпример передаётся reviewer.
- Подготовлен новый чистый полный A исправленной редакции, 34 документа,44 проверенных source hashes; manifests/snapshots сохранены отдельно. ROB-772 пока In Progress, изменения runtime отсутствуют. Новый A не видит registry/отзыв первого A.

- Corrected full A session1df48316-a77d-4ca5-b68f-d20f29856372: ready_for_implementation с1Medium/5Low; нет блокеров этапов1–3. Уточнены single session-owner/legacy generation cutoff и fenced rollback, explicit read-only assist в human, StageRule keys, sequence после restore, operational payload retention и старые схемы. Две низкие находки порождены текущим schema/FIFO уточнением и явно учтены в registry. Следующий чистый полный кандидат передан новой сессии; history не копируется в пакет.
- Проверенные исходники: search/export useReplica:true, datasource replicaPool fallback, MessageThreadTarget только Person/Company/Opportunity. Source inventory расширен40→44 без runtime изменений. Первичная mechanical проверка:503 local links без пропусков, JSON parse,58 stable IDs после уточнений; точные финальные counts фиксируются отдельно.

- R12 final A needs_revision: три Medium/четыре Low. Исправлены unified root-set runId/effectKind, primary native permission inputs, human observedSequence, FIFO replacement, lock modes и timeline chronology. B проверил все60 ID, оставил один N-21 Low (две старые строки); его исправление подтверждено targeted finalcheck. B ready_for_implementation, все60 closed_in_plan;25 проявлений R12 учтены. Последний fresh A не заменяется B: общий pass не заявлен, ROB-772 остаётся In Progress.
- Повторная source сверка45 файлов с pinned729f6236 совпала (LF-normalized). Новых функций/деплоя/реальных сообщений нет. Заголовки актуальных документов очищены от устаревших R7/R10/R11 counters; это metadata-only правка после технической сверки. Следующий общий допуск требует уменьшить дублирование нормативных определений, не просто запустить четвёртый одинаковый круг. Публикация/API read-back записываются ниже.

- Проверки перед публикацией LOG-014:536 local Markdown links без пропусков;48 JSON валидны;60 уникальных причин/60 closed_in_plan;45 source SHA и pinned-source сравнение совпали; diff --check пройден. Abstract model1712/23 пройдена в своём scope.50 изменённых/новых файлов только PROJECT/Research, runtime/ops нет; credential-pattern scan без совпадений. Dry-run Linear подготовил11 описаний, параллельных изменений задач не обнаружил.

- Публикация LOG-014: commit `c528af60543e9c29a11eea0b23f64e2df20a61da` отправлен в origin/codex/omnichannel-requirements. Все11 описаний Linear записаны и независимо прочитаны обратно; статусы не изменились, ROB-772 blocks ROB-764 сохранена. [Отчёт LOG-014](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-25b870fd) существует ровно один. Автоформатирование Linear ошибочно сделало hyperlink из названия поля в двух строках; строки переписаны обычным текстом без изменения контракта и read-back повторно совпал. Текущий итог:60 closed_in_plan в B, не fresh full pass; ROB-772 In Progress, ROB-764 Todo.


### 2026-10-26 — LOG-015 — единые определения и разрешённый четвёртый полный круг

- Пользователь явно разрешил четвёртый круг и удаление дублирующих определений. Baseline 01beb156d34bfb4acea15ba8aec51a4b4e574a52; fix-and-recheck документов, полный протокол cross-review-convergence. Claude consult/transparent integration и linear-api; runtime/БД/deploy/реальные сообщения вне этого шага.
- Введены plan/contracts: workflow execution, access/control и sending/UI с единым индексом владельцев. Полная schema/UNIQUE остаётся в spec §3. Старые разделы сохраняют ссылки; design/09 — навигация. Повторные формулы и определения в API/models/decision tables заменены ссылками; phase docs явно производные задачи/проверки. Уникальные transport/runner/receipt требования сохранены.
- Manifest фиксирует130 переносов/замен с SHA256 исходных блоков и4 дополнительных точных дубля. Все130 hashes совпали с baseline;115 ссылок на anchors разрешаются. Механические проверки до review:657 local links,45 source hashes, abstract model1712 случаев/0 failures/23 пойманных negative controls. Это не runtime tests.
- Свежий A запущен через официальный Claude CLI в новом allowlist packet:38 документов и31441 source/config/test file. Предыдущие registry/reports/RECONCILIATION, .git, CLAUDE/AGENTS/SKILL не копировались. A не получает старые findings; B будет отдельным продолжением только после сохранения A. Итог/модель/tool audit/публикация фиксируются ниже после завершения.


- Итог LOG-015: fresh A (claude-opus-5-5) needs_revision:1 high/4 medium/4 low и5 editorial. Исправлены действующие owners/schema/API/phases: AI-turn fence/scanner и prepared effectOrdinal, missing durable entities/fields, replyRevision вместо SSE sequence, G13b owner gate, API coverage, global admission dedup, generation reconciliation, restoreIncarnation.
- B ready_for_implementation/63 closed_in_plan нашёл4 low производных расхождения; внесены правки, self-review уточнил lock order parent turn/intent до Command. Finalcheck закрыл B-1/B-2/B-4/N-6; B-3 исправлен exact tuple и закрыт отдельным подтверждением. Неточные matchers двух редакционных замен были обнаружены и исправлены; простая замена cursor→observedReplyRevision подтверждена local assert.24 проявления сохранены в реестре,3 новых root IDs, всего63. Raw отзывы не переписывались.
- Fresh full acceptance последней редакции не заявляется: после последнего A технические изменения проверены B/targeted. ROB-772 остаётся In Progress, ROB-764 Todo, пятый широкий круг не запускался. Runtime/DB/deploy/реальных сообщений нет. Публикация и Linear read-back ниже.

- Проверки перед публикацией LOG-015:673 local Markdown links,61 JSON valid,63 уникальных closed_in_plan,45 source hashes и pinned-source LF comparison без расхождений; abstract model1712/0/23. Diff --check пройден;51 файлов только PROJECT/Research. Credential-pattern scan с границами token без совпадений; первичное совпадение внутри имени ask-...integration-spec.ts оказалось false positive. Два прежних R12 labels в registry обнаружены финальной проверкой и обновлены по фактическому R13 B. Linear dry-run подготовил11 описаний, параллельных изменений description/state не обнаружено. Это не runtime/production evidence.

- Публикация LOG-015: основной commit e60d26e1 и финальные records `183039a3c16b0e4b4a3495805ba42bf9e0d51e76` отправлены в origin/codex/omnichannel-requirements. Все11 descriptions Linear обновлены и проверены read-back, статусы прежние и ROB-772 blocks ROB-764 сохранены. [Отчёт LOG-015](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-1df99847) существует ровно один. Read-back первоначально отличался только percent-encoding кириллических URL fragments; после эквивалентной URL-нормализации все11 совпали, повторных mutations не делалось.63 closed_in_plan по B/targeted, без fresh full pass после исправлений; ROB-772 In Progress, ROB-764 Todo.


### 2026-10-26 — LOG-016 — авторская проверка и свежий Claude A

- Пользователь разрешил шаг 1 вместе с Claude Code. Baseline f212cd12ddadefe88265d32fd6effdeb4dc9dcb1. Продолжен fix-and-recheck документов, полный протокол cross-review-convergence; Claude CLI transparent integration и linear-api. Runtime/DB/deploy/сообщения клиентам не выполняются.
- Новая сессия bbe0ee5d-b689-4c16-8ba4-ea22d3d4ee02, reported model claude-opus-5-5: 39 технических документов и 31441 source/config/test file; прежние registry/verdict/history отсутствовали. Audit A: 51 Read/6 Glob/19 Grep, 0 outside packet/unexpected tools. В packet остаётся нейтральное упоминание существования исключённого журнала; его содержание/вердикты не переданы.
- Авторский codex-r14-review сохранён до чтения ответа Claude. Проверены нормативные контракты и representative source paths, включая WorkspaceTransactionScope/WorkspaceDataSource/WorkspaceOrmManager, messaging persistence, RunWorkflowJob и front defaults/core mutation. Автор новых блокеров не выявил; это не второй слепой reviewer и не построчный проход всех документов.
- Fresh A: needs_revision, 1 Medium + 6 Low, без Critical/High. Замечания подтверждены; исправлены схема immutable execution reference, legacy DRAFT/manual ingress, дублированный lock order, глобальная connector command identity, send response control epoch, enum history_import и API проверки outcome evidence. Новая runtime реализация не создана. Полные findings/лимиты source inspection сохранены без пересказа как claude-r14-full-a.md.
- Перед B: 680 local links без пропусков, 45 source hashes и LF-сравнение с pinned729f6236 совпали, 63 уникальных root IDs; abstract model1712/0/23. Модель не покрывает новые reference/resolution/editor contracts, SQL/transport/UI; T01–T33 остаются будущими. B получает исправленные39 документов и только после A — реестр, dispositions и авторский отчёт. Итог и публикация фиксируются ниже.

- Итог LOG-016: B ready_for_implementation подтвердил F1–F7 и63 stable roots, но нашёл2 Low в производных местах. B14-1 lock order исправлен/закрыт finalcheck; B14-2 table layout исправлен/закрыт отдельным read после удаления оставшегося blank.9 проявлений,0 новых roots. Автор указал ошибку довода B о секретности commandId; reviewer признал, F4 закрыт на authorization evidence. Последний fresh A предшествует изменениям: общий full pass не заявлен, ROB-772 In Progress и ROB-764 Todo. Широкий новый круг не запускался. Финальные механические проверки/публикация/Linear — ниже.

- Финальные проверки LOG-016: 692 local links без пропусков, 69 JSON valid,45 source hashes/pinned comparison совпали,63 уникальных root IDs; abstract model1712/0/23. Residual asserts проверили lock chain, непрерывную connector table, global commandId и history_import. Diff --check и credential-pattern scan без проблем. 35 файлов только PROJECT/Research; Linear dry-run подготовил11 описаний, параллельного изменения задач нет. Tool audit всей сессии:65 Read/7 Glob/33 Grep,0 outside/unexpected. Это не runtime evidence.

- Публикация LOG-016: commit `be6f6cf93ad834fdade377f01ca98201850477c2` отправлен в origin/codex/omnichannel-requirements. Все11 описаний Linear обновлены и проверены read-back; прежние статусы и ROB-772 blocks ROB-764 сохранены. [Отчёт LOG-016](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-a1e260b1) существует ровно один. ROB-772 In Progress, ROB-764 Todo.9 проявлений исправлены/подтверждены B и targeted, но fresh full A исправленной редакции не проводился; runtime/деплоя/реальных сообщений нет. Следующая работа — отдельно согласованный допуск к реализации; broad loop автоматически не запускается.


### 2026-10-26 — LOG-017 — полный независимый проход окончательной редакции

- Пользователь явно разрешил полный независимый проход и закрытие ROB-772 при выполнении критериев. Baseline `dbea730b88da4206cf2520ef9c843df35552fa40`, чистая ветка codex/omnichannel-requirements. Полный протокол cross-review-convergence; новый Claude A получает39 документов и исходники pinned2.52, без истории/registry/verdict. Технический пакет фиксируется до результата A, изменения runtime/деплой/сообщения не входят.
- Linear plugin вернул UNAUTHORIZED/re-authentication required; использован ранее настроенный linear-api helper без вывода credentials. Свежий read: ROB-772 In Progress, ROB-764 Todo, ROB-765–771 Backlog, ROB-762/763 Done. Никакие статусы ещё не изменены.
- Memory quick pass содержит прежнюю SaleBot-backed/draft-only архитектуру и не используется как актуальное требование; текущий источник — документы форка. Evidence/модель/результат и публикация будут записаны ниже.

- Подготовка packet выявила предсуществующую ошибку normalizer: старые абсолютные пути из editorial map указывали на другой Temp packet. Исправлены только source-link prefixes и остаточные IDs в headings; технические контракты не менялись. Initial manifest/snapshot сохранены. До исправления audit показал31 Read/3 Glob и0 outside calls; независимость контекста сохранена. Для следующих пакетов старые Temp prefixes должны нормализоваться до запуска.

- R15 A needs_revision:3 Medium/5 Low. Подтверждены native targetsOnly/desiredTargets расширение и background reconcile (source bodies), public webhook controller без auth, missing initial queue/mode и schema/assignment/gates/CRON gaps. Исправлены владельцы и derivations; WEBHOOK сохранён через signed ingress. Self-review добавил FK unique target, captured webhook credential refs и общий CRON lock mode.11 проявлений,3 новых root IDs,66 всего. Новый независимый полный pass исправленной редакции не заявляется; B проверяет исправления и реестр.


LOG-017, продолжение: R15 B — needs_revision, девять Low проявлений у девяти существующих корней; 57 остальных закрыты в плане. B1–B9 исправлены в owners/API/phases. Для аудита выбран transaction context с flush до COMMIT; для cron — gap до продвижения cursor; для webhook expiry не отменяет уже принятый WAIT, explicit revoke немедленно запрещает эффекты. Участники хранятся только в ConversationMember. Queue disable запрещён для любой непустой очереди. ROB-764 fixtures изолированы, реальная activation зависит от ROB-766. Запущена targeted проверка той же сессией; это не новый blind A.

Производные evidence обновлены: PACKET_INDEX после B, 49 исходников с хэшами (добавлено чтение WorkflowCronTriggerCronJob). Первая попытка подготовки final packet запущена из packet cwd и остановилась на отсутствии manifest; после явного запуска из проектного cwd все39 документов успешно скопированы и хэши49 source files проверены до старта Claude. Технические файлы проекта первой ошибочной попыткой не менялись.


LOG-017 итог: адресные проверки подтвердили27/27 проявлений и66/66 root IDs closed_in_plan. Отдельный ConversationReadCursor устранил смешение участия/прочтения; минимальный audit context и T06 входят ROB-764, ROB-765 расширяет ORM/merge/bulk. Все текущие сводки и skill/document audits обновлены; raw reports сохранены. Full A исправленной редакции не выполнялся; ROB-772 In Progress, ROB-764 Todo. Следующий широкий цикл автоматически не запускался по правилу повторных раундов cross-review-convergence. Коммит/push и Linear read-back фиксируются после публикации ниже.


LOG-017 опубликован: commit `41e3b3667d006c1651dc2a7e72925c06ae53fd24` отправлен в origin/codex/omnichannel-requirements. Linear обновлены11 описаний с permalink на этот commit; API read-back подтвердил все11 и неизменные статусы, ROB-772 blocks ROB-764 сохранена. [Единственный отчёт LOG-017](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-bd21f234); повторная выборка подтвердила один комментарий. [Метаданные публикации](plan/cross-review/publication-r15.json). Рабочий каталог после первого push чистый, ahead/behind0/0. Следующий commit фиксирует только эту публикацию; техдокументы после reviewer confirmation не менялись.


## LOG-018 — R16, новый независимый полный проход (27.10.2026)

Пользователь явно разрешил следующий круг: «Да, запускай». Режим fix-and-recheck, полный протокол; план/документы/Linear, без runtime/деплоя. Baseline `b896cee207526a33c475550f317bdacb98fd0bab`. Основание: предыдущий fresh A нашёл существенные дефекты, текущие исправления подтверждены только targeted. Новый A проверяет весь итоговый план без прошлых findings. Изолированный packet39 документов,49 source hashes, preflight source links/history/auto-instructions выполнен до запуска; технические тексты не изменены. Fresh Linear snapshot: ROB-772 In Progress, ROB-764 Todo, ROB-765–771 Backlog, ROB-762/763 Done. Старые memory-заметки SaleBot-backed не применяются к нынешнему replacement scope.


LOG-018: A needs_revision (3 Medium/7 Low), без Critical/High. Author подтвердил dynamic WorkspaceMember schema и CLASSIFY→AiEvaluationService. Исправлены owners: immutable AutomationPolicyVersion, общий root effects/hops ledger, административный receipt/CAS, FK/lifecycle, cancel authority, API index, sequence/state, SSE recheck и assist scope. Self-check устранил stage dependency через disabled v0 bootstrap, добавил author mapping storage, стабильный receipt tombstone и полные captured policy IDs.17 проявлений,8 порождённых patch,66 root IDs, B ожидается. Скрипт первой правки остановился на несовпадении русского заголовка lock protocol; последующие шаги выполнены отдельно по точному HTML-якорю, первая часть не повторялась. Runtime не менялся.


LOG-018 B:17 проявлений закрыты, но1 Medium/4 Low регрессии. Исправлены: policy-head fence вместо массового UPDATE, канонический порядок locks, zero-hop initial plan, schema table/owner index, удаление неиспользуемой revision и human policy provenance. С учётом отдельных producers —25 проявлений,16 порождены patch. Количественный стоп достигнут вместе с R15 (16/27): после адресной проверки новый широкий раунд той же формы не запускается. Требуется решение о смене подхода, не скрытый pass.


LOG-018 итог: C1–C5 исправлены и подтверждены;30/30 проявлений и66/66 причин closed_in_plan. Итог широкого цикла escalate по quantitative stop, не full fresh pass. Предложено решение владельца о переходе от повторного план-ревью к реализации ROB-764 с SQL/contract tests; acceptance самостоятельно не изменена. Все текущие сводки, registry и audit skills обновлены. Механические проверки и52 source hashes проходят;31441 файлов source packet совпали с pinned базой. Новый runtime/деплой не начат. Commit/push и Linear read-back фиксируются после публикации.


LOG-018 опубликован: commit `f5d806119250cdf589de20cd755da1552e079b14` отправлен в origin/codex/omnichannel-requirements. Linear: обновлены и прочитаны обратно все 11 описаний; статусы не изменены, ROB-772 blocks ROB-764 сохранена. [Единственный отчёт LOG-018](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-5cfabfd8); повторная выборка подтвердила один комментарий. [Метаданные публикации](plan/cross-review/publication-r16.json). После основного push рабочий каталог чистый, ahead/behind 0/0. Следующий commit фиксирует только публикацию и дату сверки; технические контракты не менялись.


## LOG-019 — начало ROB-764, 27.10.2026

Пользователь: «хорошо приступай» после предложения принять исправленный план за основу и перейти к коду. Решение владельца завершает ожидание после R16: ROB-772 закрывается как планирование, ROB-764 In Progress. Это не full fresh pass исправленного R16 и не готовность системы. [Критерий перехода, реализация и остаток](implementation/rob764-progress.md).

Первая порция: fork-only migration type/runner и отдельный runtime-safe verifier; DB advisory transaction lock, DDL+ledger atomic commit, prefix/checksum/shape checks, read-only readiness. Production manifest/CLI/startup пока не подключены; реальных chat entities нет. Добавлен immutable Enterprise source baseline и CI no-new-dependency guard; baseline debt не легализуется и остаётся ROB-766/G18. Исходные runtime файлы Twenty и лицензии не менялись.

Проверено: 16 PostgreSQL integration tests PASS, включая параллельные migrators, rollback до ledger, backend termination, replay, checksum/shape drift и runtime роль без DDL/ledger writes. Без test URL запуск отказал до соединения. 20 guard fixtures PASS, полный static graph: 34389 code files / 21251 runtime / 134751 edges, 0 violations. Focused strict TypeScript 5.9.3 и форматирование PASS. [Evidence](implementation/rob764-foundation-verification.json), [Jest output](implementation/rob764-postgres-tests.txt). Полный server build/typecheck и настоящий Twenty upgrade/restart не выполнялись; синтетический cursor не выдаётся за них.

Среда: локально нет node_modules/WSL, Node22. Изолированные тесты выполнены на Шрёдингере: временный PG17 с уникальной БД/tmpfs/internal network (384MiB/1CPU), test runner в существующем pinned app image с нашим source mount (1GiB/2CPU), временные Jest/SWC/TypeScript tools. Первоначально SWC binary не совпал по libc с Alpine image; установлена соответствующая musl версия в отдельном test tooling. После этого все проверки прошли. Демо/рабочая БД/коннекторы не изменялись, сообщения не отправлялись. Очистка собственных временных ресурсов фиксируется ниже.

Адресное self/subagent review: найден duplicate-manifest обход в readiness; вынесена общая валидация, добавлен отрицательный тест, повтор пройден. Уточнён предел ledger shape check (колонки/types/nullability/PK, не вся DDL certification). Во время self-review обнаружено пересечение test discovery со штатной integration suite; выбран отдельный .postgres-spec.ts suffix, не совпадающий с native patterns. Полный архитектурный круг не запускался.

Skills: ai-dev-workflow — уже согласованный Plan → Implement, узкая порция/verify/review; behavioral-guardrails — scoped changes и проверка файлов после правки; server-schrodinger — read-only preflight и ограниченные изолированные тесты; linear-api — fallback после reauthentication error плагина. Субагент по ai-dev-workflow исследовал migration call sites, реализовал dependency guard и сделал адресное ревью.

Следующая порция: настоящие entities и штатная генерация up/down на isolated upstream schema, source-checksummed fork manifest, fail-fast CLI/startup и оставшиеся T33, затем audit/ingress/outbox. До собственных прав реальные bindings выключены. Commit/push и Linear read-back записываются после публикации.

LOG-019 cleanup: после проверки имени/image/network/tmpfs удалены только собственные временные PG container и internal network `twenty-rob764-e9f2b662ed54420d`. Тестовая БД находилась в tmpfs и уничтожена. Папка `/opt/twenty-tests/twenty-rob764-e9f2b662ed54420d` с source snapshot и test tooling оставлена как изолированный cache для следующей порции; активных процессов в ней нет. Контейнеры twenty-demo server/worker/db/redis продолжают работать.

LOG-019 опубликован: `28cdc295b69103074e95ce93d67117950815db83` в origin/codex/omnichannel-requirements. Read-back11 описаний/статусов подтвердил ROB-772 Done, ROB-764 In Progress, остальные статусы сохранены. Dependency ROB-772 → ROB-764 сохранена как выполненная предпосылка. По одному комментарию LOG-019 в [ROB-764](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-8753ea7f) и [ROB-772](https://linear.app/robotrts/issue/ROB-772/podrobnyj-plan-vsego-twenty-crm-i-krossrevyu-s-claude-code#comment-a06f566a). [Публикация](implementation/publication-log019.json).

GitHub Actions: оба workflow завершены failure до запуска job (0 steps). Аннотация GitHub: “The job was not started because your account is locked due to a billing issue.” [PostgreSQL run](https://github.com/marketozk/twenty/actions/runs/40426837916), [dependency guard run](https://github.com/marketozk/twenty/actions/runs/40426837919). Это блокировка CI аккаунта, не падение выполненных тестов. Облачный CI pass не заявляется; собственные16 PG/20 guard tests и focused typecheck прошли. Биллинг/настройки аккаунта не менялись, повторный запуск не инициировался.

## LOG-020 — 27.10.2026: первая группа схемы ROB-764

Пользователь: «хорошо делай». Продолжена реализация по принятому плану,
без развёртывания новой порции в демо и без переключения клиентских каналов.

Реализованы9 core entities: WorkspacePolicyState, AccountBinding, Queue,
AutomationPolicy/Version, ExternalIdentity, Conversation, Member, ReadCursor.
23 FK и15 CHECK; composite tenant/binding constraints, bigint как строки,
disabled-v0 bootstrap shape. Динамические Person/Thread/Member IDs без фиктивных
FK; native account pairing и runtime authorization остаются domain writer.

В изолированной PostgreSQL17 выполнена настоящая upstream core initialization.
Штатный CLI generator сначала показал пустой baseline, после новых entities
создал instance command. 68 SQL-вызовов up/down без изменений перенесены в
fork-only registry; upstream decorators/registration исключены. Добавлены
LF-source checksum manifest/CI check, schema verifier, независимый apply/verify
CLI, Nest JSON asset declaration и подготовленный runtime wrapper.

Проверки:35 PostgreSQL tests,25 Python tests, полный no-new Enterprise dependency
guard (0 violations), focused strict TypeScript PASS. На настоящей upstream core
schema apply/verify/replay сохранили все256 строк upgradeMigration и одну запись
fork ledger; wrapper отказал при drift/неправильной настройке и запустил test
command при готовности. Empty generated down/up прошёл. [Evidence](implementation/log020/README.md).

Адресное subagent review: SQL совпадает с raw generator, tenant/binding FK
проверены; найден пропуск NOT VALID/DEFERRABLE/index validity в readiness.
Добавлены catalog checks и regression tests. PG test выявил недетерминированный
порядок колонок TypeORM index introspection; использован pg_get_indexdef,
проверка перестановки колонок проходит. Тип workspaceId в test helper уточнён.
После исправлений scoped review без новых находок; полный круг планов не запускался.

Skills: ai-dev-workflow — Implement/Verify и адресное независимое ревью;
behavioral-guardrails — изменения только текущей порции и проверка diff;
server-schrodinger — отдельные ограниченные containers, readonly preflight;
linear-api — синхронизация после публикации через сохранённый API fallback.
Субагент выполнил entities и schema tests, затем два адресных code-review прохода.
Claude Code в этой порции не запускался.

Ограничения: не выполнены полный server build/Nest packaging, populated native
workspace upgrade и actual server/worker restart. Wrapper ещё не подключён
к live entrypoints. Нет runtime bootstrap, audit writer, ingress/outbox и внешних
сообщений. ROB-764 остаётся In Progress; T01–T33 целиком не закрыты.

Cleanup: после проверки имён/images/network/mounts удалены только собственные
PG/Redis containers, Redis anonymous volume и internal network. Обе временные
БД уничтожены с tmpfs. Source/tool caches сохранены без активных процессов;
демо server/worker/db/redis продолжают работать. [Read-back](implementation/log020/cleanup.json).

Следующий шаг: упаковка/подключение мигратора и gate к фактическому startup,
полный build/restart T33; затем остальные schema entities, audit/bootstrap и
ingress/outbox. Commit/push и read-back ROB-764 фиксируются после публикации.

LOG-020 опубликован: `ab0402f3fddd890fb31fb504ad4502ad9b7caa2a` в
origin/codex/omnichannel-requirements. [Комментарий ROB-764](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-4b311d13),
описание и In Progress проверены чтением; статусы всех11 задач проекта сохранены.
[Метаданные публикации](implementation/log020/publication.json).
Оба GitHub job отказали до запуска из-за billing block: [PostgreSQL](https://github.com/marketozk/twenty/actions/runs/40456531281)
и [dependency guard](https://github.com/marketozk/twenty/actions/runs/40456531260).
Аннотации подтверждены; это не CI pass и не падение выполненных35/25 проверок.
Настройки оплаты не менялись. Результат отражён в том же комментарии Linear.

## LOG-021 — 27.10.2026: packaging/migrator/startup ROB-764

Пользователь: «хорошо делай». Выполнен следующий шаг LOG-020: полный официальный
Docker build и фактический запуск через отдельный migrator и runtime gate.
Live demo, рабочие БД и маршруты Telegram/MAX не изменялись.

Новый координатор удерживает session lock над native/fork upgrade, определяет
fresh/existing/partial DB через pg_namespace и прекращает child process group
при наблюдаемой потере lock connection. Автоповтора нет. Native cache flush,
upgrade status и cron registration получили opt-in strict errors; legacy callers
сохраняют прежнее поведение. Compose разделяет роли и блокирует runtime при
отказе migrator. Worker grace6 минут учитывает native AI stream drain5 минут.

Проверки:38 PostgreSQL,15 strict command,7 Linux shell,20 dependency и5 source
checksum tests PASS; focused strict TypeScript координатора/lock tests PASS.
Официальная сборка пересобрала server, unchanged frontend использовал cache;
оба Nest JSON assets и реальные main/worker/coordinator присутствуют в image.
Fresh migration, populated upstream upgrade и replay прошли. Проверены полный
row fingerprint599 компаний,150 сделок,1200 контактов, startup/restart двух пар
server/worker и отдельная non-owner runtime роль с SELECT-only fork ledger.
Compose подтвердил отказ dependency chain и успешный запуск после исправления.
После ожидания26 собственных queue subscriptions worker завершился exit0
за5,45s. [Evidence](implementation/log021/README.md).

Находки и исправления: swallowed native errors, отсутствие общего upgrade lock,
privilege-filtered schema discovery; UNIQUE introspection order нормализован
как набор, обычные index order и FK mappings сохранены. Первичный короткий stop
до подтверждённой готовности worker дал137 без OOM; readiness/stop проверка
уточнена и пройдена. Последнее адресное subagent review — без новых замечаний.
Полный архитектурный круг и Claude Code в LOG-021 не запускались.

Ограничения: session lock не обеспечивает DB-side fencing всех child sessions
после disconnect; maintenance owner должен удерживать окно до разбора исхода.
Старый runtime останавливается до cache flush, который затрагивает EngineLock.
Не добавлять fork-table queries в AppModule bootstrap до fork DDL. Полный server
typecheck не выполнялся (SWC build без type checking); runtime permissions,
provisioning и audit ownership не сертифицированы этими smoke tests. Это T33
для текущих9 таблиц, не готовность всех T01–T33. Existing Enterprise debt ROB-766
не изменён; no-new-dependency guard не является доказательством лицензии.

Среда и cleanup: внутренний network, PG17/tmpfs1GiB, Redis256MiB, runtime до3GiB/
2CPU без published ports. После identity/mount/volume ownership checks удалены
собственные9 containers, их exclusive volumes и network; тестовые БД уничтожены.
Неактивные source/tool caches и два test image оставлены. Idle builder возвращён
в исходное stopped состояние. Демо health/read-back подтверждены. [Cleanup](implementation/log021/cleanup.json).

Skills: ai-dev-workflow — Implement/Verify и адресное независимое ревью;
behavioral-guardrails — узкие изменения и проверка diff; server-schrodinger —
изоляция/лимиты и cleanup только своих ресурсов; linear-api — синхронизация
через сохранённый API fallback после недоступности подключённого инструмента.

Следующий шаг: остальные entities этапа1, минимальный audit writer и защищённый
bootstrap, затем ingress persistence/transactional Message/inbox/outbox/recovery.
ROB-764 остаётся In Progress; bindings не активируются до ROB-766.
Публикация и read-back Linear/CI фиксируются после commit/push.
