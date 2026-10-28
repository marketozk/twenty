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
LOG-021 опубликован: `bf044eb6fddb535cec0b958d689e5e714ce9443d` в
origin/codex/omnichannel-requirements. [Отчёт ROB-764](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-6822fa04).
Описание и единственный комментарий LOG-021 проверены чтением; статусы всех11
задач сохранены. [Метаданные](implementation/log021/publication.json).
Оба GitHub job отказали до запуска из-за billing block: [PostgreSQL](https://github.com/marketozk/twenty/actions/runs/40474962521)
и [dependency guard](https://github.com/marketozk/twenty/actions/runs/40474962526).
Аннотации подтверждены; облачный CI pass не заявлен, выполненные85 тестов прошли.
Настройки оплаты не менялись.

## LOG-022 — 27.10.2026: минимальный audit writer и bootstrap ROB-764

Пользователь: «хорошо делай». Реализована зависимость дальнейшего ingress:
CrmAuditEntry в отдельной crm_audit schema, PolicyMutationReceipt, transaction
audit context и внутренний writer inactive AccountBinding/disabled policy v0.
Остальные MessageLink/IncomingReceipt/OutgoingCommand/DomainEvent и inbox/outbox
остаются следующей порцией; публичного API и реальных сообщений пока нет.

Один primary QueryRunner/policy UPDATE fence; текущий authorizer до исполнения
и replay, native tenant/account/channel ownership, запрет Application/Provider
parent. Binding/policy/head/epoch/success audit/receipt фиксируются вместе.
Replay возвращает прежний result/operationId; hash conflict и expired result
отказывают. Unknown COMMIT не записывает ложный failed; подтверждённый rollback
порождает отдельный attempt, ошибка отрицательного аудита явно сообщается.
Неподтверждённый rollback и ошибки освобождения соединения не маскируются.

Аудит агрегирует first-before/last-after, сохраняет только разрешённые поля;
UUID canonicalization и immutable key/hash конфликт обязательны. Runtime verify
до Nest и writer проверяют append-only DB privileges, включая column grants,
owner membership и SET ROLE. Мигратор использует owner и не меняет grants.
Каталог пока пять служебных сущностей; покрытие всей CRM остаётся ROB-765.

Штатный generator дал6 SQL-вызовов up/down, перенесённых без изменения в fork
registry; добавлен explicit CREATE SCHEMA crm_audit. Старый migration checksum
не изменён. @Generated('uuid') уточнил существующую restoreIncarnation metadata
по реальной БД и устранил ложный baseline diff без изменения прежней DDL.
На actual native core empty down/up, прежние9 tables и все256 history rows
сохранены. [Evidence](implementation/log022/README.md).

Проверено:81 PostgreSQL,20 dependency,5 source checksum,7 Linux shell tests PASS;
focused strict TypeScript40 файлов с imports PASS. Официальный Docker target
twenty собран; actual image проверил assets, новый fork prefix/replay, runtime
owner refusal, append-only role acceptance и column-write refusal. Полного server
typecheck нет (native SWC build без него). Полная auth/provision/background
permission certification, runtime activation и новый UI не заявляются.

Находки исправлены: TypeORM UPDATE RETURNING shape → CTE SELECT, account parent
ownership, UUID-case audit duplication, sparse-array canonical hash collision,
потерянный commit ACK/negative audit path. No-new-Enterprise guard обнаружил
barrel dependency через twenty-shared/utils; заменено на существующий
class-validator, baseline не ослаблен. Финальное адресное crossreview PASS,
Claude Code и полный архитектурный круг в LOG-022 не запускались.

Skills: ai-dev-workflow — принятое Design/Plan → Implement/Verify и независимое
адресное ревью двух исполнителей; behavioral-guardrails — узкие изменения и
проверка файлов; server-schrodinger — read-only preflight и ограниченная
изолированная PostgreSQL/Redis среда без портов; linear-api — сохранённый API
fallback для синхронизации при недоступном подключённом инструменте.

В собранном image дополнительно прошёл полный native+fork migrator replay;
все256 строк native history сохранились. Удалены собственные PostgreSQL/Redis
containers, exclusive volume и внутренняя сеть, временные БД уничтожены вместе
с tmpfs. Idle builder возвращён в stopped; source/tool caches и candidate image
оставлены неактивными. Live demo health и прежние start timestamps подтверждены.
[Cleanup](implementation/log022/cleanup.json). Live demo и коннекторы не менялись.
ROB-764 In Progress, ROB-772 Done как планирование; реальные bindings остаются
выключенными до ROB-766.

LOG-022 опубликован: `128a3526daa143bdd7b69d5bdff4fbc3f5c27c97` в
origin/codex/omnichannel-requirements. [Отчёт ROB-764](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-d5d606e7).
Описание и единственный комментарий прочитаны обратно; статусы всех11 задач
сохранены. Оба GitHub job не стартовали из-за billing block аккаунта, причина
подтверждена аннотациями; выполненные113 тестов прошли, облачный CI pass не заявлен.
[Публикация и аннотации](implementation/log022/publication.json).

## LOG-023 — 27.10.2026: сверка документации и задач после LOG-022

По просьбе пользователя «Запиши, обнови документацию и задачи» сверены PROJECT,
STATUS, DEVLOG, roadmap, индекс плана, этап аудита и текущие описания задач Linear.
ROB-764 уже содержал LOG-022. Найдены устаревшие сводки LOG-019 в десяти других
задачах и двух вводных документах: они ошибочно представляли сборку и схему как
ещё не проверенные. Вводные документы обновлены и ссылаются на текущий STATUS.

В этапе2 зафиксированы реальные пути audit context/writer/entity, отдельная
crm_audit schema и граница сделанного: пять служебных сущностей, bootstrap call
site, QueryRunner. Подключение native workspace scope, полный охват CRM и UI
остаются будущей работой ROB-765/767. Второй writer не проектируется.

Код и работающие сервисы не менялись; новый запуск тестов не нужен для этой
документационной сверки. Следующий шаг разработки остаётся ROB-764: остальная
схема сообщений/команд/событий, затем ingress/outbox.

Документы опубликованы: `05af4f4e9ec87c09814871c692d9d5fa52c7e943`.
Через подключённый Linear обновлены десять устаревших описаний; ROB-764 уже
соответствовал LOG-022. Описания всех11 задач и сохранение статусов проверены
повторным чтением. ROB-762/763/772 Done, ROB-764 In Progress, ROB-765–771 Backlog.
Критерии и зависимости сохранены; ROB-765 уточнён по актуальному этапу2.
[Отчёт LOG-023](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-a3d32f51)
создан один раз и прочитан обратно. [Метаданные сверки](implementation/publication-log023.json).
Проверены локальные ссылки, diff и сохранность22 хешей исходников LOG-022.

## LOG-024 — 27.10.2026: схема сообщений и надёжного хранения

Пользователь разрешил следующую порцию ROB-764. Добавлены шесть core entities:
MessageLink, MessageRevision, ConversationTarget, IncomingReceipt, OutgoingCommand,
DomainEvent. Штатный generator создал56 SQL up/down, перенесённых без изменения
в fork registry; старые migration checksums сохранены. Provider IDs — text,
bigint — string; tenant/binding/conversation FK защищают связь, reply и replacement.
Это schema-only: domain writers, отправка и UI не заявляются реализованными.

Для composite Link FK у Conversation добавлен UNIQUE(workspaceId,bindingId,id).
Обнаружена необходимость version-aware snapshot: прежний exact snapshot иначе
отвергал бы корректный upgrade. Ledger prefix целиком валидируется до callbacks;
схема проверяется строго для соответствующего prefix, post-up до commit.
Старые snapshot/migration исходники сохранены, generic drift checks не ослаблены.

Проверки:113 PostgreSQL,20 dependency guard и5 checksum tests —138 PASS.
Focused strict typecheck49 файлов с imports PASS. Первичный typecheck отказал
на выведенном UUID template type test helper, исправлен явной string-аннотацией.
Native schema up/down/up сохранила старые11 таблиц после down и остальные10 после
up; все256 native upgrade history rows сохранены. Зарегистрированные upgrade,
replay/readiness прошли, финальный штатный generator diff пустой. Полного нового
image build и полного server typecheck не было. [Evidence](implementation/log024/README.md).

Адресное независимое ревью entities, FK, ledger/snapshot и тестов — PASS без
подтверждённых blocker/major. Claude Code и новый полный архитектурный круг не
запускались. ORM update:false не является SQL immutability; acceptance evidence
test не является доказательством готовой send state machine. Future reference/
root/turn FK и dynamic workspace validation указаны как незавершённая работа.

Собственные временные PostgreSQL/Redis containers, exclusive volumes и сеть
удалены после проверки принадлежности; БД уничтожены вместе с tmpfs. Неактивный
source/tool cache сохранён, builder не запускался. Demo image/start timestamps/
health совпали с прежними; живые каналы не менялись. [Cleanup](implementation/log024/cleanup.json).

Skills: ai-dev-workflow — продолжение принятого плана, независимое исследование
и адресное ревью; behavioral-guardrails — узкий diff и проверка по диску;
server-schrodinger — read-only preflight, ограниченная тестовая среда и cleanup
собственных ресурсов. Linear обновляется подключённым инструментом.

Следующий шаг: ранние roots/consumer receipts/dispatch plans/reply budgets и
activation/admission, затем ingress/inbox/outbox/recovery. ROB-764 In Progress,
ROB-765–771 Backlog.

Код опубликован: `161269d6b166cc4fe34ea85fefc47162342381d8` в
origin/codex/omnichannel-requirements. Описание ROB-764 и единственный
[отчёт LOG-024](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-a5c2ec75)
прочитаны обратно; статусы11 задач сохранены. Оба GitHub job не стартовали из-за
billing block, подтверждено аннотациями. [Метаданные](implementation/log024/publication.json).

## LOG-025 — 27.10.2026: схема событий, запусков и общих лимитов

Пользователь разрешил продолжение ROB-764. Добавлены восемь core entities:
RootExecution, RootBudgetCharge, EventDispatchPlan, ReplyBudget, ReplySlot,
RouteActivation, AutomationAdmission, ConsumerReceipt. Budget сохраняется
отдельно от slots, включая нулевой предел. Captured policy связана с root через
composite FK; admission связан с MessageLink и Event того же диалога. Ключи
consumer/admission не расширяются pinned version/activationVersion.

Штатный generator после пустого baseline создал 64 SQL-вызова up/down;
перенесены без изменения в четвёртую fork migration. Три прежних source/checksum
сохранены. DomainEvent получил root FK и composite UNIQUE для admission.
Version-aware snapshot выбирается по проверенному prefix, без ослабления
старых checks. Legacy NULL root допустим; orphan root вызывает rollback всей
новой миграции с сохранением прежних записей и ledger prefix 3.

Прошли 135 PostgreSQL, 20 dependency guard и 5 checksum tests — 160 PASS.
Focused strict typecheck 60 файлов с imports PASS. Native up/down/up восстановил
17 прежних таблиц после down, сохранил остальные 16 после up и 256 записей
истории. Зарегистрированные upgrade/replay/readiness прошли; итоговый generator
diff пустой. Нового полного image/server typecheck не было.
[Evidence](implementation/log025/README.md).

Адресное независимое ревью entities/FK, registry/snapshots/checksums и тестов —
PASS без подтверждённых blocker/major. Claude Code и полный архитектурный круг
не запускались. Runtime writers, cross-row quota, initial-event membership,
source-position comparison, permissions и lifecycle не выдаются за готовые.
`update:false` не является запретом прямого SQL. Spec §3 уточнён по физическому
разделению budget/slots и структурному conversationId admission; основные
семантические владельцы контрактов не дублируются.

Собственные временные PostgreSQL/Redis containers, exclusive volumes и сеть
удалены после проверки идентичности. Неактивные caches оставлены; builder не
запускался. Demo image/start timestamps/health прежние, живые каналы не менялись.
[Cleanup](implementation/log025/cleanup.json).

Skills: ai-dev-workflow — реализация по принятому плану и независимое адресное
ревью; behavioral-guardrails — минимальный diff и фактические проверки;
server-schrodinger — preflight, ограниченные тестовые ресурсы и их cleanup.
Следующая порция: ingress persistence с canonical envelope/hash, generation,
durable ACK и payload conflict; затем Message+audit+event/inbox/outbox/recovery.
ROB-764 остаётся In Progress, ROB-765–771 Backlog.

Код опубликован: `4cc66d8900d673994dae701e0fbfbc6c5f39615d` в
origin/codex/omnichannel-requirements. Описание ROB-764 и единственный
[отчёт LOG-025](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-f111f44a)
прочитаны обратно; статусы 11 задач сохранены. GitHub CI нового коммита не начал
выполнение из-за billing block аккаунта; подтверждено аннотациями обоих jobs.
[Метаданные](implementation/log025/publication.json). Настройки оплаты не менялись.

## LOG-026 — 27.10.2026: внутренний приём событий и собственные проверки

Пользователь разрешил продолжение и исключил GitHub Actions из разработки.
У двух наших omnichannel workflows убраны automatic push/PR triggers, оставлен
workflow_dispatch. Проверки в своей среде и commit/push обязательны; правило
записано в CLAUDE, статусах и задачах. Upstream workflows и billing не менялись.

Реализован acceptOmniIncomingEvent: current trusted principal/authorizer,
существующий policy SHARE → binding SHARE → active/generation → durable receipt.
Natural key и semantic hash обеспечивают replay текущего состояния и conflict
при изменённом payload. Envelope отделён от mutable input до первого await.
Receipt+success audit атомарны; failure audit только после confirmed rollback;
неопределённый COMMIT/release даёт typed unknown, без ложного ACK/failed outcome.
Новый audit catalog ресурс ограничен metadata, без текста/идентификаторов источника
в открытом diff. Новых таблиц/миграций нет, четыре checksum сохранены.

Добавлены strict Zod envelope v1, generated JSON Schema и синтетические Telegram/
MAX fixtures. Поддержаны только текстовые message.received/edited/deleted;
остальные kinds отвергаются до ACK. Decimal-string generation и provider IDs
не округляются; unknown authority fields запрещены. Unicode/128 KiB ограничения
зафиксированы. Source position и author metadata не назначают доверие/полномочия.
Schema и конкретные ограничения ссылаются из design/06 и spec §15.16.

Проверки: 169 PostgreSQL (34 новых ingress), 42 envelope unit, 20 dependency guard,
5 checksum tests — 236 PASS. Focused strict typecheck 64 файлов PASS. Общий Jest
config включает schema unit tests, поэтому они не выпадают из будущих проверок.
Dependency graph без новых нарушений. [Evidence](implementation/log026/README.md).
Полный server typecheck и новый полный image не выполнялись; схема не менялась,
новый native upgrade круг не требовался и не заявляется.

На адресном независимом ревью найдена и исправлена проверка lone UTF-16 surrogate
перед jsonb; лимиты длины согласованы в Unicode code points. Финальное ревью
writer/audit/контрактов — без подтверждённых blocker/major. Дополнительные PG
сценарии подтвердили конкурентный conflict, release после фактического COMMIT
и отсутствие ложного failed audit при неподтверждённом ORM rollback.
Claude Code и новый полный архитектурный круг не запускались.

Собственные временные containers/exclusive volumes/network удалены после
проверки идентичности. БД уничтожены с tmpfs, неактивные caches оставлены.
Builder не запускался, demo image/start timestamps/health сохранены.
[Cleanup](implementation/log026/cleanup.json). Сервис пока вызывается только
тестами: HTTP/HMAC, runtime credentials/ACL, Message apply, коннекторы и чаты
не выдаются за готовые. Синтетическая авторизация находится только в тестах.

Skills: ai-dev-workflow — реализация по принятому плану и независимые исследование/
ревью; behavioral-guardrails — scoped changes и проверка фактов; server-schrodinger —
read-only preflight, ограниченные тестовые ресурсы и cleanup своих ресурсов.
ROB-764 In Progress; далее worker claim/lease, атомарное Message+audit+event,
inbox/outbox/recovery и email regression.

Код `2025ce939ac1c672cf1843d0005bfdb9b2ffdb04` отправлен в текущую ветку,
удалённый SHA подтверждён API GitHub. Описание ROB-764 и единственный
[отчёт LOG-026](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-b00c93a8)
прочитаны обратно; статусы 11 задач сохранены. Actions не запускались и не
ожидались. [Метаданные](implementation/log026/publication.json).

## LOG-027 — 27.10.2026: владение обработкой входящих событий

Пользователь разрешил продолжение ROB-764. Реализованы внутренние claim/reclaim,
renew и defer для IncomingReceipt; новые таблицы/миграции не понадобились.
В spec §4 закреплены eligibility, bounded limits и receipt-only transitions;
общий порядок locks и отдельный будущий config wake-up не дублируются.

Claim берёт policy/binding SHARE и current authorization, выбирает due
accepted/retryable_error либо expired processing текущего поколения через
SKIP LOCKED. Token/attempts увеличиваются атомарно. Renew/defer после receipt lock
повторно проверяют processing, owner/token/generation и clock_timestamp().
Старый worker не меняет новое владение или состояние. Renew не сокращает lease;
defer очищает её и сохраняет bounded retry либо blocked_config/quarantined.
Closed reason-code catalog исключает произвольные ошибки в открытом audit diff.

Каждая transition и audit имеют один QueryRunner/COMMIT, отдельный operationId;
envelope/hash/generation не меняются. Неопределённый COMMIT/release возвращает
typed unknown без ложного успеха/failed audit. После unknown claim обработчик
не начинает apply по неподтверждённому владению. Восстановление после expiry
опирается на PostgreSQL; Redis не участвует в этих функциях.

Исследование native пути подтвердило: WorkspaceTransactionScope использует pg
executor, audit пока ожидает TypeORM QueryRunner/lifecycle. Нужен adapter к тому
же executor и unknown-commit contract, без отдельной core connection. Общий
native importer создаёт свою транзакцию и postcommit matching, поэтому не подходит
для вложенного omni apply. Прямой callback под receipt lock инвертировал бы
Conversation/Identity locks. В LOG-027 нет applied/native Message callback или
scheduler; это зафиксировано явно, без объявления фиктивного успешного Message.

Проверки: 225 PostgreSQL, включая 56 новых lease cases, 42 envelope unit,
20 dependency guard и 5 checksum — 292 PASS. Focused strict typecheck 66 файлов
PASS. Перепроверены concurrency/SKIP LOCKED/reclaim, DB clock после lock wait,
auth/generation, audit rollback, unknown COMMIT/release, точность bigint и
сохранность immutable receipt. Local/uploaded LF-SHA256 совпали; четыре migration
checksums прежние. [Evidence](implementation/log027/README.md).

Независимое адресное ревью writer/audit/контрактов — без подтверждённых blocker/
major. Claude Code и новый полный архитектурный круг не запускались. Нового
полного image/server typecheck и native Message acceptance не было.
Собственные test containers/exclusive volumes/network удалены после проверки
идентичности; БД уничтожены с tmpfs. Неактивные caches оставлены, builder не
запускался; demo image/start timestamps/health прежние.
[Cleanup](implementation/log027/cleanup.json). Живые каналы не менялись.

Skills: ai-dev-workflow — исследование native/lease путей, реализация по плану,
независимое ревью; behavioral-guardrails — минимальный scope и проверяемые границы;
server-schrodinger — preflight, ограниченная тестовая среда и cleanup своих ресурсов.
GitHub Actions не запускались и не ожидались. ROB-764 In Progress; далее audit
executor adapter/unknown commit, native Message+audit+event, config wake-up и
inbox/outbox/recovery.

Публикация LOG-027: `306e2522fd11b316bfbf668fe365edd9fc104e91`, remote HEAD
подтверждён GitHub API. Описание ROB-764 и единственный
[отчёт LOG-027](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-82f2637b)
прочитаны обратно; статусы 11 задач сохранены. Actions не запускались и не
ожидались. [Метаданные](implementation/log027/publication.json).

## LOG-028 — 27.10.2026: общий native executor и строгий исход транзакции

Пользователь разрешил непрерывную реализацию согласованного плана до проверенных
критериев, без остановки после каждой порции; правило добавлено в CLAUDE.md.
Сделан audit adapter к исходному native pg executor с active lifecycle и
workspace check. QueryRunner callers совместимы, append-only gate/redaction
сохранены. Strict commitOutcome включается явно; legacy default сохранён.
Unknown COMMIT/rollback/release не превращается в успех/подтверждённый откат;
COMMIT с command ROLLBACK также отклоняется. Retained scope/executor закрываются.

Добавлены suppression wrapper для шести native messaging repositories и
reserved header refs из квалифицированного canonical key. Никакого угадывания
identity по raw provider ID. Первый dependency guard обнаружил Enterprise
transitive edge через широкий scope type; исправлено leaf lifecycle/структурным
контрактом, guard не ослаблялся. Независимые адресные ревью без blocker/major.

Проверки: 239 PG + 93 unit + 20 dependency guard + 5 checksum = 357 PASS;
после type-only annotation повторены 31 helper tests. Все четыре миграции прежние.
Сравнительный TypeScript проход по 75 roots: 0 новых/0 в изменённых файлах,
122 baseline diagnostics сохранены. Три wording differences неизменённых
source/line/code сохранены отдельно. Полный server typecheck не зелёный,
production image/новое архитектурное Claude review не выполнялись.
[Evidence](implementation/log028/README.md).

Нативные PG tests проверяют настоящий runner + минимальный scope/probe fixture,
а не metadata Message acceptance. Реальная Message/Person integration — следующий
шаг. Найден gap: helper сам назначает Thread UUID, но Conversation требует
canonical Thread заранее; нужен узкий expected-thread contract с collision
checks. Capture provenance/qualification, ownership, core writers и background
exclusions ещё впереди. applied/доступность чатов не заявляются.

Тестовая сеть/БД изолированы, ограничены ресурсами и переиспользуются в следующей
порции; рабочее демо/живые каналы не менялись. GitHub Actions не запускались.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; независимые
субагенты исследовали/реализовали/ревьюили разделённые части. ROB-764 In Progress.

Публикация LOG-028: `1445dea548457aa01e4d81af35cc8d737f056baf`, remote SHA
подтверждён API. ROB-764 description и единственный
[комментарий](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-4fd0c275)
прочитаны обратно, статусы 11 задач прежние.
[Метаданные](implementation/log028/publication.json). Продолжаем LOG-029.

## LOG-029 — 27.10.2026: native Message, canonical Thread и аудит

Добавлен optional expected Thread contract к штатному messaging helper. Mapping
фиксируется до await, проверяется точное покрытие, workspace/strict lifecycle;
existing header/channel conflicts и текущие tombstones отклоняются. Найденный
ревью дефект исправлен: удалённая старая история не мешает новому сообщению.
Audit omniMessage требует binding/conversation и не раскрывает body/subject/header.

Проверки: 261 PG + 93 unit + 20 guard + 5 checksum = 379 PASS. После исправлений
типов повторены 19 native PG. Сравнительный typecheck 101 roots: 0 новых/0 в
изменённых файлах, 141 baseline расширенного графа сохранена. Реальные native
metadata/repositories/SQL проверяют Message и Person relation с атомарным audit;
fixture не включает полный ownership/каналы/receipt apply. Все четыре миграции
прежние. Независимое адресное ревью без blocker/major. [Evidence](implementation/log029/README.md).

Демо и живые каналы не менялись, bounded test resources переиспользуются.
GitHub Actions не используется; Claude Code/full architecture review не запускался.
Skills ai-dev-workflow, behavioral-guardrails и server-schrodinger: разделённая
реализация/ревью, проверяемые границы, изолированные ограниченные проверки.
Далее trusted capture context, domain writers и полный apply. ROB-764 In Progress.

Публикация LOG-029: `971fa17fa6b0c83d332b19689df0c51d34f1a6cf`, remote SHA
подтверждён GitHub API. Описание ROB-764 и комментарий `e9ecaf38-03b8-4ca5-956f-649de9b995fa`
прочитаны обратно, 11 статусов прежние. [Метаданные](implementation/log029/publication.json).
Продолжаем LOG-030 без остановки.

## LOG-030 — 27.10.2026: trusted capture и безопасный replay

Добавлен закрытый detached/frozen контекст происхождения/квалификации с hash
полного wire envelope. Ingress принимает его только с отдельным текущим
server authorizer; фиксирует callback до parse/await. Ревью выявило и исправило
accessor-подмену callback. Контекст+receipt+redacted audit атомарны, changed context
и NULL↔qualified дают conflict. Старые строки NULL без backfill/угадывания live.

Пятая миграция: штатный генератор, 3up/3down SQL без изменений; prefix-aware
verifier, прежние4 source/checksum сохранены. Native up/down/up, registered
apply/replay/readiness и final metadata zero-diff пройдены,256 history rows сохранены.
294 PG +146 unit +20 guard +5 checksum =465 PASS. Typecheck106roots:0new/0changed,
141 baseline остаётся. Исправлена test-only structuredClone realm несовместимость,
serializer не ослаблен. [Доказательства и пределы](implementation/log030/README.md).

Full apply, реальные adapter qualification/import permissions и live каналы ещё
не готовы. Immutability service/ORM, не отдельный raw SQL trigger. Независимое
адресное review PASS после P2, Claude/fullarchitecture review не запускался.
Демо прежнее, bounded test resources переиспользуются. Actions не используется.
Skills ai-dev-workflow, behavioral-guardrails, server-schrodinger: разделение
работ/ревью, проверяемый scope, изолированные генерация и PG tests. Продолжаем
ownership guards и domain apply; ROB-764 In Progress.

Публикация LOG-030: `5f7dbd4eea45bbd744e1a17755a155b72549fb60`, remote SHA
проверен API. Описание ROB-764 и комментарий `ceff46f9-db0d-45b6-8a5a-f1285921bc2c`
прочитаны обратно, 11 статусов прежние. [Метаданные](implementation/log030/publication.json).
Продолжаем LOG-031.

## LOG-031 — 27.10.2026: APP ownership guard

ApplicationMessageIngestionService проверяет persisted binding любого статуса
после app ownership, до identities/cache/aggregate. Tenant/channel query
параметризован, ошибки/некорректный boolean fail closed. Прежний APP mapper/output
сохранён; default core DataSource DI/call sites проверены. Helper независим отEE.

7 PG +10 actual-service unit +20 guard +5 checksum =42 PASS. Полный suite здесь
не повторялся, LOG-030 остаётся последним полным440+25. Typecheck110roots:0new/
0changed,155 baseline расширенногоAPPgraph сохранено. Пять migration sources
не менялись. [Доказательства и пределы](implementation/log031/README.md).

Scopedreview PASS; Claude/fullarchitecture pass не запускался. Это point-in-time
APP guard, не закрытие binding TOCTOU, background/cleanup или T05. Демо прежнее,
boundedtestresources переиспользуются. Actions не используется. Skills:
ai-dev-workflow, behavioral-guardrails, server-schrodinger — разделённое исследование/
реализация/ревью и изолированные проверки. Продолжаем rematch/targets и domainapply.

Публикация LOG-031: `7f102dfdf622f4533e666c7c92c5e98feb998958`, remote SHA
проверен API. Описание ROB-764 и комментарий `9d2e3dec-f7ab-46bc-aff7-551646ae9a56`
прочитаны обратно, 11 статусов прежние. [Метаданные](implementation/log031/publication.json).
Продолжаем LOG-032.


## LOG-032 — 27.10.2026: background ownership exclusions

Native participant rematch/target reconciliation исключают omni Message/Thread
по persisted binding/link/conversation, включая mixed batches и no-scope path.
Обычные email/APP/calendar сохраняют поведение. Tenant context обязателен;
ошибки SQL не разрешают запись. Все5 миграций неизменны.

525 Jest/22 suites +25 guards =550 distinct PASS; после двух type-only test fixes
повторены68 тестов. Typecheck115roots:0new/0changed,136 baseline. Изолированные
locked lodash devtypes устранили19 baseline diagnostics в обеих сторонах.
Dependency guard обнаружил broad-import EE edges; исправлены imports/ownership
контекст без ослабления guard. Scoped independent review PASS.
[Доказательства/ограничения](implementation/log032/README.md).

Полный T05/ROB-764 не закрыты; lifecycle/cleanup/generic mutations ещё впереди.
Демо прежнее; Actions не используется. Skills: ai-dev-workflow (разделение
исследования, реализации, ревью), behavioral-guardrails (bounded scope и факты),
server-schrodinger (изолированные лимитированные проверки). Далее receipt apply.


Публикация LOG-032: `e80d9dece4b42e34f462e444cb91898a2350c24d`; remote SHA проверен API. Описание ROB-764 и комментарий `fa995c17-80a1-4e93-b037-358dd51ef8cc` прочитаны обратно, все11 статусов прежние. [Метаданные](implementation/log032/publication.json). Продолжаем LOG-033.


## LOG-033 — 27.10.2026: atomic history receipt apply

Новый native facade+domain writer сохраняют qualified history text к существующему
диалогу/Person с Link/Revision/Event/suppressed Root/Dispatch/audit/applied receipt
одним strict scope. Owner contract уточняет storage-only suppressed root и resultId.
Повторное чтение после Conversation lock устраняет concurrent duplicate race;
lease CAS после audit.flush устраняет expiry во время аудита. Неизвестный commit
не получает ложный failed audit. Действия с ошибкой аудируются отдельно после rollback.

558 Jest/23suites +25guards =583 PASS; новые33 PG, включая7 SQL write failures.
Typecheck119roots:0new/0changed-code,136baseline. Одна старая TS2345 в неизменённом
методе подтверждена AST/полным текстовым сравнением, не исправлялась попутно.
UnknownError вынесен leaf, старый export/class identity сохранены; dependency
контроль PASS без исключений, все5 migration checksums неизменны.
[Доказательства и пределы](implementation/log033/README.md).

Scoped independent review PASS. Production authorizer/live/новые Conversation/Person/
edit/delete/admission/полный T05 ещё впереди; ROB-764 In Progress. Демо не менялось.
Skills: ai-dev-workflow — раздельная реализация/проверка/review; behavioral-guardrails —
ограниченная ветка без ложной готовности; server-schrodinger — изолированные PG tests.
GitHub Actions не используется. Продолжаем native cleanup/lifecycle ownership guards.


Публикация LOG-033: `ab0a69aa1de352a9b2d12132245d77ed355ea4db`; remote SHA проверен API. Описание ROB-764 и комментарий `024f4cee-eecc-4f2f-b857-0752b76ed7a3` прочитаны обратно, все11 статусов прежние. [Метаданные](implementation/log033/publication.json). Продолжаем LOG-034.


## LOG-034 — 27.10.2026: native cleanup ownership

Защищены три центральных cleaner entry, blocklist delete и folder junction path.
Пагинация по id продвигается до фильтрации; workspace context проверяется.
Реальные PostgreSQL tests используют native repos и FK actions из metadata.
Первый прогон выявил две ошибки тестового seed: повторные associations нарушали
штатный unique index. Seed исправлен отдельными Message в общем owned Thread;
ограничения БД сохранены. Исправлены два типа fixture без runtime suppression.

583 Jest/24 suites +25 guards =608 PASS. После независимого замечания fixture
перестаёт навязывать strict-mode production cleaner: передаёт options как есть;
все25 cleanup tests повторно PASS. Typecheck124roots:0new/0changed,136baseline.
Пять миграций и dependency guard baseline неизменны. Scoped independent review
без блокеров; новый полный Claude/architecture pass не заявляется.
[Доказательства](implementation/log034/README.md).

Метаданные папок/аккаунтов/каналов и lifecycle races ещё впереди. В частности,
caller после folder cleanup пока может удалить core folder, хотя защищённые
junctions сохранены. Полный T05/ROB-764 не завершён. Демо не менялось.
Skills: ai-dev-workflow (разделённые implementation/review), behavioral-guardrails
(точные границы), server-schrodinger (ограниченные изолированные проверки).
GitHub Actions не использовался. Продолжаем LOG-035 lifecycle guards.


Публикация LOG-034: `863a3a0ae72e1fae7fa70bd686025c8543f1739d`; remote SHA проверен API. Описание ROB-764 и комментарий `4752855f-4672-46a1-b0c6-1eda69278025` прочитаны обратно, все11 статусов прежние. [Метаданные](implementation/log034/publication.json). Продолжаем LOG-035.


## LOG-035 — 27.10.2026: metadata lifecycle preflight

Account disconnect/deleteMany/transfer/update и channel update/delete (generic/APP)
останавливаются до первых внешних/DB эффектов при persisted ownership. Reset
фильтрует весь снимок IDs до cache; folder actions сохраняет protected metadata,
но обычная соседняя папка обрабатывается. Whole-batch account отказ исключает
частичное отключение ordinary accounts. Ошибка SQL не открывает доступ.

Ревью обнаружило обход через relation-shaped update и save(existing supplied id).
Проверены TypeORM UpdateQueryBuilder referencedColumn и текущие callsites create
без заданных IDs: relations требуют scalar validated route, supplied create ID
отвергается. Добавлены negative/ordinary controls. Typecheck обнаружил2 enum
ошибки тестов (исправлены) и3 baseline unknown-catch в изменяемом методе:
ошибка нормализуется, pending action остаётся для retry; string/null tests добавлены.

667 Jest/27 suites PASS; затем86 focused PASS, включая2 новых cases:669 distinct
Jest +25 guards =694 PASS. Typecheck133roots:149baseline→146current,0new/0changed.
Первоначальный Node heap1.5/2.3GB не вместил расширенный metadata graph. После
проверки available RAM~103GiB одноразовый runner ограничен6GiB/2CPU, heap4608MiB;
production/BuildKit не менялись. Все5 миграций и dependency baseline прежние.
[Доказательства](implementation/log035/README.md).

Scoped independent review без блокеров после исправлений; новый полный Claude
review не заявляется. Это point-in-time guards, не TOCTOU fence или полныйT05.
Другие scheduler/direct-repository paths и полноценный domain lifecycle впереди.
Skills: ai-dev-workflow (раздельные исследования/реализация/review),
behavioral-guardrails (пределы), server-schrodinger (лимитированные проверки).
Демо прежнее, Actions не запускались. Продолжаем first Conversation/Thread apply.


Публикация LOG-035: `0eccf952d91f42eec78d272230be75b1e54b5f7a`; remote SHA проверен API. Описание ROB-764 и комментарий `f62440c4-0a1f-4666-9f6c-beb0f20fcbb1` прочитаны обратно, все11 статусов прежние. [Метаданные](implementation/log035/publication.json). Продолжаем LOG-036.


## LOG-036 — 27.10.2026: first Conversation/Thread и blocked_config bridge

LOG-036 / ROB-764 In Progress: первое qualified history-сообщение атомарно
создаёт Conversation/Thread по действующим default queue/human mode и существующим
verified Identity/Person. Параллельные receipts сходятся в одном диалоге;
conversation.created и message.received имеют отдельные suppressed roots/events.
Подтверждается фактическое создание native Thread, rollback и replay проверены.
Нет подходящей конфигурации — тот же receipt переводится в blocked_config после
подтверждённого rollback; неизвестный COMMIT не превращается в retry/успех.
701 Jest/29 suites +25 guards =726 PASS. Typecheck136roots:0 новых/0 changed-code,
146 baseline/current; все5 миграций прежние. [Доказательства и границы](implementation/log036/README.md).
Далее — bounded восстановление blocked_config, затем config producer/consumer,
остальные inbox/outbox пути. HTTP/own ACL/UI/живые коннекторы не подключены;
полные ROB-764/T05 и lifecycle races ещё открыты. Демо прежнее, Actions не используется.

Независимый scoped review закрыл race переиспользования Thread проверкой реального
native insert. Первые2 failures относятся к test harness, исправлены; полный финальный
прогон701 PASS. Same-thread foreign Message race не подтверждён: FK ждёт Thread lock.
Подробные подтверждения и ограничения — в evidence README. Skills: ai-dev-workflow
(implementation/review), behavioral-guardrails (границы), server-schrodinger (изолированные
проверки). Полный Claude cross-review повторно не заявляется. Следующий шаг LOG-037.


Публикация LOG-036: код 533fc589ca8774ca28e3266636409d7c14850caa, remote проверен GitHub API. Описание ROB-764 и комментарий fc300f88-88b2-4060-8ae0-c5b56b27c37e прочитаны обратно; все11 статусов сохранены. Продолжаем LOG-037.


## LOG-037 — 27.10.2026: bounded blocked history resume

LOG-037 / ROB-764 In Progress: typed bounded resume возвращает qualified history
blocked_config/configuration_missing в retryable_error с прежним receipt и capture.
Текущие права/config/generation проверяются; existing Conversation сохраняет собственную
очередь независимо от defaults. Точный DB cursor, full-page progress и SKIP LOCKED
проверены; новый проход без cursor подбирает пропуски. Аудит атомарен, unknown COMMIT
не объявляется успехом. Реальная цепочка repair→resume→claim→apply проверена.
745 distinct Jest (полный прогон744/745 + исправленный focused44) +25 guards =770 PASS.
Typecheck140roots:0 новых/0 changed-code,
146 baseline/current; все5 миграций прежние. [Доказательства и границы](implementation/log037/README.md).
Далее — настоящий config writer и durable binding.config_changed, затем typed
consumer/housekeeping и остальные inbox/outbox пути. Полный recovery pipeline,
ROB-764/T05, own ACL/UI/HTTP и живые коннекторы ещё не готовы. Демо прежнее,
GitHub Actions не используется.

37 new PG +7 facade unit cases. Первый focused43PASS/1FAIL, полный744PASS/1FAIL:
тест ожидал raw P0001/один cause, ORM оборачивает дважды. Исправлена проверка cause chain;
финальный focused44PASS, все745 distinct кейсов прошли. Runtime между прогонами прежний.
Независимое scoped review leaf и facade без блокеров. Skills: ai-dev-workflow,
behavioral-guardrails, server-schrodinger. Следующий LOG-038 — config mutation writer;
schema уже поддерживает nullable-conversation event, но audit descriptor needs narrow
binding-event support. Full worker recovery ещё не объявляется готовым.

Публикация LOG-037: код 377da6291ad8d93bf9c96e63bfb04d5c4d022fde, remote проверен GitHub API. Описание ROB-764 и комментарий eda007d4-a5a7-40b4-a616-cc33deaf852d прочитаны обратно; все11 статусов сохранены. Продолжаем LOG-038.


## LOG-038 — 27.10.2026: config mutation writer

LOG-038 / ROB-764 In Progress: config writer создаёт/изменяет очереди и human
defaults binding с current authorization, CAS и общим idempotency receipt.
Policy UPDATE с начала; resource revision/epoch, durable binding.config_changed,
audit и receipt атомарны. No-op не выпускает event; replay повторно проверяет права.
Default/retained queue нельзя отключить, existing Conversations не переносятся.
Actual writer→resume→claim→apply проверен; binding activation остаётся test-only.
826 Jest полного прогона + финальные84 focused (3 новых) +25 guards =854 distinct PASS.
Typecheck145roots:0 новых/0 changed-code,146 baseline/current;5 миграций прежние.
[Доказательства и границы](implementation/log038/README.md). Далее — typed event consumer и durable recovery/
housekeeping, затем остальные inbox/outbox пути. ROB-764/T05, own ACL/UI/HTTP и живые
коннекторы ещё не готовы. Демо прежнее, GitHub Actions не используется.

Root проверил TypeORM raw UPDATE shape и исправление CTE SELECT. Scoped independent
review без блокеров; сохранена причина двойного rollback failure, добавлены3 реальные
rollback/release cases. 826 full +84 focused:829 distinct Jest,25 guards;854PASS.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; unban-ssh-schrodinger
использован для диагностики intermittent SSH (MaxStartups), разбан/firewall changes
не потребовались; одна batch SSH session восстановила проверку. Следующий LOG-039 —
typed consumer/durable maintenance recovery, full stage пока не завершён.

Публикация LOG-038: код 872f337fe81eb6428a1c7ae2236e28b4be6bcbc2, remote проверен GitHub API. Описание ROB-764 и комментарий e117d3c8-e60b-41e1-9a82-57125d85521e прочитаны обратно; все11 статусов сохранены. Продолжаем LOG-039.


## LOG-039 — 27.10.2026: durable config wakeup

LOG-039 / ROB-764 In Progress: config events получают отдельный durable wakeup.
Typed claim/page/reconciliation/rearm сохраняют checkpoint и текущую авторизацию;
receipt transitions, audit и финальный lease CAS атомарны. Exact DB cursor,
SKIP LOCKED rescan, generation reset, inactive/unknown handler и lost COMMIT ACK
проверены. Producer создаёт event+wakeup в одном commit; replay/no-op без дублей.
Шестая миграция сгенерирована Twenty, native up/down/up проверен; прежние5 неизменны.
890 Jest/35 suites +26 guards =916 PASS; targeted204 PASS. Typecheck152roots:
146 baseline/current,0 новых/0 changed-code. [Доказательства и границы](implementation/log039/README.md).
Далее — strict runtime owner и bounded housekeeping, затем остальные inbox/outbox
пути. Scheduler/current production grants, полные ROB-764/T05, own ACL/UI/HTTP и
живые коннекторы ещё не готовы. Демо прежнее, GitHub Actions не используется.

Root review исправил точность nextAttemptAt в producer/audit и финальный claim expiry.
Первый targeted204 PASS; typecheck нашёл один Promise union в новом test helper,
исправлено async. Финальный полный890 PASS, typecheck0 new/changed. Независимое
scoped review без блокеров; полный Claude cross-review не заявляется.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger. Продолжаем LOG-040.

Публикация LOG-039: код be0039477d482fad53d7c868c73269e14bb4973a, remote проверен GitHub API. Описание ROB-764 и комментарий 03b3a849-07b1-4d39-b0f1-0675d015e646 прочитаны обратно; все11 статусов сохранены. Продолжаем LOG-040.


## LOG-040 — 27.10.2026: strict recovery owner

LOG-040 / ROB-764 In Progress: recovery связан с существующим strict native
transaction owner. Пять закрытых команд, snapshot до await, свежие grants;
failed/denied audit только после подтверждённого rollback, unknown ACK без false failure.
Housekeeping возвращает один последний завершённый проход для поздних blocked
receipts. Реальный accepted→blocked→repair→wakeup→claim/apply→Message+Person проверен,
включая defer после завершения config event. 226 Jest/11 затронутых suites +26 guards
=252 PASS; финальные21 unit повторены после исправления test typing. Typecheck155roots:
146 baseline/current,0 новых/0 changed-code; одна baseline ошибка в неизменённом
старом методе. Все6 миграций и прежние методы aggregate неизменны.
[Доказательства и границы](implementation/log040/README.md). Далее — human command admission и исходящая очередь.
Scheduler/current production grants, полные ROB-764/T05, own ACL/UI/HTTP и живые
коннекторы ещё не готовы. Демо прежнее, GitHub Actions не используется.

Полный fork suite890 последним прошёл в LOG039; здесь повторены11 затронутых
suites, новые38 cases и native transaction regressions. После 226PASS исправлено
только typing jest getter spy в новом тесте; финальные21 unitPASS, runtime прежний.
Независимое scoped review facade/snapshot/housekeeping без блокеров; полный Claude
cross-review не заявляется. Skills: ai-dev-workflow, behavioral-guardrails,
server-schrodinger. Продолжаем LOG-041: первый human text command/outbox.

Публикация LOG-040: код 7fc9f425fd2937fbcdae82ec47ac29bf5aa5162f, remote проверен GitHub API. Описание ROB-764 и комментарий 06e55d29-8e42-43c1-aeb4-af6dc6202808 прочитаны обратно; все 11 статусов сохранены. Продолжаем LOG-041.

## LOG-041 — 27.10.2026: human text command admission

LOG-041 / ROB-764 In Progress: приём human text command атомарно сохраняет
pending Command, три счётчика Conversation, suppressed event/root/dispatch и аудит.
Текущие native member/user/workspace и grants проверяются также при replay; key
общий для actor/workspace, UI CAS применяется к новому намерению. Проверены
конкурентные ключи, реальный revoke lock, rollback каждого write и lost COMMIT ACK.
Полный fork suite: 1025 Jest /41 suites +26 guards =1051 PASS; 97 новых cases.
Typecheck162roots:146 baseline/current,0 новых/0 changed-code. Все6 миграций и
прежние методы aggregate неизменны. [Доказательства и границы](implementation/log041/README.md).
Далее — outbox claim/FIFO и восстановление попыток. Writer пока text-only/v0,
с injected current grants; HTTP/UI, transport, scheduler и own ACL ещё впереди.
Полные ROB-764/T05 не закрыты. Демо прежнее, GitHub Actions не используется.

Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Scoped независимое
ревью без блокеров. Enterprise barrel dependency снята без exemption; direct UPDATE
RETURNING заменён CTE SELECT согласно настоящему QueryRunner. Retained membership
проверяется EXISTS, чтобы повторное вступление не ломало denied audit. Новый полный
Claude cross-review и полный server build/typecheck не заявляются. Продолжаем LOG-042.

Публикация LOG-041: код 8e764d01037d3f9ea32082d35dd685872441717a, remote проверен GitHub API. Описание ROB-764 и комментарий 838d3898-d413-4b7f-b15c-d0d7145e9313 прочитаны обратно; все 11 статусов сохранены. Продолжаем LOG-042.

## LOG-042 — 27.10.2026: human outbox lease

LOG-042 / ROB-764 In Progress: human outbox claim/FIFO/recovery реализован.
First attempt проверяет автора и текущий маршрут; исторический reconcile использует
отдельные worker grants и не разрешает повторную отправку. UUID lease, DB expiry,
statusRevision и audit атомарны; final CAS после аудита, unknown ACK без false failure.
194 Jest /10 затронутых suites +26 guards =220 PASS, включая32 новых PG cases.
Typecheck170roots:146 baseline/current,0 новых/0 changed-code; все6 миграций и старые
методы aggregate неизменны. Полный1025 suite прошёл в LOG041.
[Доказательства и границы](implementation/log042/README.md). FIFO пока bounded100 с явным отказом сверх лимита;
qualification/verifier injected, без production implementation. Далее — verified
connector acceptance reducer. HTTP/UI, transport, scheduler/own ACL и полный
ROB-764 ещё не готовы. Демо прежнее, GitHub Actions не используется.

Root review сохранил journalSequence=0 согласно существующей схеме; verified
accepted fixture это подтверждает. Аудит задержан реальным PG trigger до expiry,
token tampering/COMMIT ACK loss проверены. Scoped review без блокеров; применены
ai-dev-workflow, behavioral-guardrails, server-schrodinger. Продолжаем LOG-043.

Публикация LOG-042: код 8e644d41396efa48e30d01a7e20cf4fda17881b5, remote проверен GitHub API. Описание ROB-764 и комментарий 9bae8625-4880-4e4a-bd83-65792248d5ca прочитаны обратно; все 11 статусов сохранены. Продолжаем LOG-043.


## LOG-043 — 27.10.2026: verified connector acceptance

LOG-043 / ROB-764 In Progress: внутренний verified connector acceptance реализован.
Current worker grant и qualified evidence обязательны также при replay. Новый
факт атомарно сохраняет proof/job/journal, меняет state/revision, снимает lease
и пишет audit; duplicate сохраняет новый reconcile lease. Historical ACK разрешён
без нового send; outcome_unknown не превращается в доставленное сообщение.
FIFO пропускает только строго сопоставленные proofs; неизвестные остаются bounded100.
285 Jest /14 затронутых suites +26 guards =311 PASS;91 новый case, включая53 PG.
Typecheck177roots:146 baseline/current,0 новых/0 changed-code; все6 миграций и
старые методы aggregate неизменны. Полный1025 suite прошёл в LOG041.
[Доказательства и границы](implementation/log043/README.md). Проверены151 подтверждённый predecessor,
23 malformed JS/SQL parity cases, rollback/lost ACK. Это внутренний server-owned
proof, не готовый протокол userbot. Далее — confirmed sent и штатный Message.
HTTP/UI, live transport, scheduler/own ACL и полный ROB-764 ещё не готовы.
Демо прежнее, GitHub Actions не используется.

Ревью выявило разницу regex end anchor и BigInt refinement для непроверенных
строк; исправлено до тестов, добавлены25 contract cases. Защищённый нормализованный
proof проверяется общей JS/SQL семантикой на реальном PostgreSQL. Применены
ai-dev-workflow, behavioral-guardrails, server-schrodinger. Продолжаем LOG-044.

Публикация LOG-043: код d0afc39501f52361afb231f2e6f1e7e4cf9d8279, remote проверен GitHub API. Описание ROB-764 и комментарий 7e2b2535-d6ba-48c3-9125-09fcf5d75bcb прочитаны обратно; все 11 статусов сохранены. Продолжаем LOG-044.


## LOG-044 — 27.10.2026: durable sent receipt

LOG-044 / ROB-764 In Progress: durable command.sent receipt accept/claim реализованы.
Закрытые envelope/capture сохраняются в существующем IncomingReceipt; current
worker grant и qualified historical verifier обязательны при capture/replay/claim.
Command/native graph пока не меняются. DB lease/token/expiry и audit атомарны,
postcondition после audit защищает от подмены; lost COMMIT ACK без false failure.
Обычный incoming claim/renew/defer исключает command.sent, сохраняя три message kinds.
487 Jest /18 затронутых suites +26 guards =513 PASS. Typecheck184roots:
146 baseline/current,0 новых/0 changed-code; все6 миграций и старые методы aggregate
неизменны. Полный1025 suite прошёл в LOG041.
[Доказательства и границы](implementation/log044/README.md). Исторический ACK не даёт нового send;
partial прежний acceptance не исправляется при capture. Далее — LOG045:
атомарный confirmed sent → штатные Message/Participant/Link/revision/event.
HTTP/UI, transport, scheduler/own ACL и полный ROB-764 ещё не готовы.
Демо прежнее, GitHub Actions не используется.

Pristine/readback postconditions проверены реальным audit trigger. Обычные incoming
kind guards проверены на всех трёх message kinds и accepted/retryable/processing
sent receipts. Scoped review без блокеров; ai-dev-workflow, behavioral-guardrails,
server-schrodinger. Продолжаем LOG045, не закрывая ROB-764 по наличию receipt.

Публикация LOG-044: код 79db08ce9146db3eea7b56095a6ef9362a3af118, remote проверен GitHub API. Описание ROB-764 и комментарий f9a74d06-42ef-4976-a57a-aba57f82da49 прочитаны обратно; все 11 статусов сохранены. Продолжаем LOG-045.

## LOG-045 — 27.10.2026: исходящее сообщение по подтверждённой отправке

LOG-045 / ROB-764 In Progress: подтверждённая отправка атомарно становится штатным
исходящим Message. Сохраняются Participant, channel association, MessageLink/revision,
один suppressed message.sent event/root/dispatch, Command sent, receipt applied и audit.
Повторы проверяют весь граф; несколько receipts одной отправки не создают дубль.
Удаление автора сохраняет историю; имя/email не выдумываются. Current worker grant
и qualified historical verifier обязательны. Собственный send не увеличивает
replyRevision повторно и не запускает AI/workflow/customer admission.
Полный fork suite: 1368 Jest /57 suites +26 guards =1394 PASS.
Typecheck191roots:146 baseline/current,0 новых/0 changed-code;
все6 миграций и старые методы aggregate неизменны.
[Доказательства и границы](implementation/log045/README.md). Проверены55 новых PG-сценариев, в том числе
fault injection, expiry после audit, concurrent replay и lost COMMIT ACK.
Далее — сохранение неопределённого исхода, backoff и поиск due Commands в PostgreSQL.
HTTP/UI, transport, scheduler/own ACL и полный ROB-764 ещё не готовы.
Демо прежнее, GitHub Actions не используется.

Ревью исправило лишнее поле при проверке channel association и запрещает скрытое
создание графа у Command, уже отмеченной sent. Проверки после audit/final CAS
находят подмену native/core данных. Typecheck выявил unknown SQL rows; добавлена
runtime-проверка структуры без any/casts. Финальные проверки повторены после правки.
Общий participant helper допускает NULL только на persistence boundary; email input
контракт сохранён и проверен. Применены ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped independent review без блокеров, полный Claude pass
не повторялся. Продолжаем LOG046, ROB-764 остаётся In Progress.

Публикация LOG-045: код 94d0d3fa43f68d5d32a34ba1758b847d6882b2bd, remote проверен GitHub API. Описание ROB-764 и комментарий dd548eab-dcf6-488a-b125-33ce5c6e3599 прочитаны обратно; все 11 статусов сохранены. Продолжаем LOG-046.

## LOG-046 — 27.10.2026: неизвестный исход и PostgreSQL recovery

LOG-046 / ROB-764 In Progress: recovery human text/v0 сохраняет outcome_unknown,
DB backoff, revision и audit атомарно. Только текущие worker grants/qualification,
точный действующий lease и captured restore incarnation допускают изменение.
Acceptance/job/journal/cancellation/payload сохраняются; sent не понижается.
Terminal/pending/superseded/expired/restore-changed дают no-op после current auth.
Discovery читает due candidates из PostgreSQL с точным курсором, не выдаёт send
permission; каждый завершённый scan начинается заново.
392 Jest /14 затронутых suites +26 guards =418 PASS;
67 новых случаев, включая33 PG. Typecheck197roots:
146 baseline/current,0 новых/0 changed-code. Все6 миграций и прежние методы
aggregate неизменны; полный1368 fork suite прошёл в LOG045.
[Доказательства и границы](implementation/log046/README.md). Проверены ACK/sent races, lost COMMIT ACK,
audit/backoff/lease expiry, AFTER UPDATE tamper, другое существующее подключение.
Далее — оставшиеся критерии outbox/state machine по этапу1; текущий slice не
закрывает ROB-764 целиком. HTTP/UI, live transport, scheduler/own ACL ещё впереди.
Демо прежнее, GitHub Actions не используется.

Независимое review выявило истёкший во время audit backoff и недостаточность одного
UPDATE RETURNING при AFTER UPDATE triggers. Оба случая исправлены и воспроизведены
на PostgreSQL. Первый общий прогон нашёл ошибочный индекс аргумента в двух новых
owner-тестах; исправлено, финальные affected tests/typecheck повторены. Существующий
чужой binding проверен отдельно; mutation входа/callbacks проверена до context await.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Scoped review
без runtime-блокеров; полный Claude pass не повторялся. Текущая queue discovery
не включает cron и не обещает ограниченной стоимости SQL при любом размере workspace.

Публикация LOG-046: код 44f313cb41ba85754448318e3dad50aada5eaace, remote проверен GitHub API. Описание ROB-764 и комментарий 868da495-7ebc-4088-81fb-1b8313ea91c2 прочитаны обратно; все 11 статусов сохранены. Продолжаем по критериям этапа1.

## LOG-047 — 27.10.2026: версия восстановления при создании Command

LOG-047 / ROB-764 In Progress: Command хранит immutable createdRestoreIncarnation.
Admission берёт её из policy под lock; первый claim требует совпадения с текущей.
NULL/старая incarnation запрещают новую отправку, replay не переписывает provenance.
Историческая сверка dispatching/accepted/outcome_unknown сохраняется, включая NULL.
Седьмая миграция additive, без default/backfill; первые6 источников неизменны.
Полный fork suite: 1460 Jest /61 suites +26 guards =
1486 PASS. Typecheck 200 roots:
146 baseline/current,0 новых/0 changed-code.
[Доказательства и границы](implementation/log047/README.md). PostgreSQL проверяет upgrade populated prefix6,
schema drift, auth/replay, policy locks и audit/AFTER UPDATE tamper.
Независимое scoped review без блокеров; полный Claude pass не повторялся.
Далее — локальная отмена ещё не переданной команды и общий native mutation guard.
ROB-764 не закрыт; restore coordinator/provider fence, HTTP/UI/ACL/transport ещё впереди.
Демо прежнее, GitHub Actions не используется.

Начальный негативный тест выявил, что TypeORM не показывает UUID generator как
column.default. Новый verifier дополнен прямой pg_attrdef проверкой отсутствия
default; старые migrations/snapshots не переписаны. Review предложил historical
NULL cases; добавлены, как и policy lock вокруг claim и tamper при audit.
Матрица приёмки отделяет собственные writers/guards от ROB-765/766/768/769/770.
Краткие пункты5–6 этапа1 приведены к нормативным владельцам T14/T16, требования
автоматизации не удалены. Применены ai-dev-workflow, behavioral-guardrails,
server-schrodinger; независимый scoped reviewer работал read-only.

Публикация LOG-047: код a70a565dd541b3e0b4f697d7ba777ef2e656e1e3, remote проверен GitHub API. Описание ROB-764 и комментарий 38ada854-d59e-4a35-9ca0-a68c490ede61 прочитаны обратно; все 11 статусов сохранены. Продолжаем локальный cancel и native mutation boundary.

## LOG-048 — 27.10.2026: локальная отмена до enqueue

LOG-048 / ROB-764 In Progress: локальная отмена human text/v0 атомарно сохраняет
cancelled/revision2, DB timestamp, закрытое доказательство и один audit. Допускается
только virgin pending с текущей creation incarnation. Текущие membership/read и
отдельный delegated grant для неавтора обязательны также на replay. Автор Command
сохраняется; отменивший сотрудник записывается отдельно. FIFO пропускает только
нормализованный local proof; remote/unknown outcome локально не отменяется.
370 Jest /14 suites +26 guards =396 PASS;
44 новых случая (34 PostgreSQL,10 owner), typecheck 205 roots:
146 baseline/current,0 новых/0 changed-code. Все7 миграций и прежние методы aggregate
неизменны; полный1460 fork suite прошёл в LOG047.
[Доказательства и границы](implementation/log048/README.md). Проверены claim/cancel race, lost COMMIT ACK,
current/delegated revoke, отсутствие audit, malformed proof/FIFO, >100 отменённых
предшественников, audit/AFTER UPDATE tamper и JS/SQL parity.
Далее — общий native mutation guard по T05/T22. ROB-764 не закрыт; публичный API,
UI, transport cancellation, собственный ACL и автоматизация ещё впереди.
Демо прежнее, GitHub Actions не используется.

Scoped independent review не нашёл blockers; его рекомендации о delegated revoke,
проверке сохранённого audit и malformed proof/FIFO добавлены в реальный PG набор.
Первый прогон обнаружил некорректный fixture lease без leaseUntil; fixture исправлен.
Typecheck выявил вызов optional delegated callback без narrowing в owner test;
исправлено и затронутые проверки повторены. Полный Claude pass не повторялся.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Транспорт,
HTTP и UI не менялись. Следующий шаг: common native write boundary; фазовая
принадлежность ROB-764 подтверждена spec §15.1, а не перенесена в будущий ACL.

Публикация LOG-048: код b4d5f8aab122a8f429ab8c205a768ef079ce9db7, remote проверен GitHub API. Описание ROB-764 и комментарий 6a5f674c-28d5-47b2-9ed6-b7c7c83487f3 прочитаны обратно; все 11 статусов сохранены. Продолжаем native mutation guard T05/T22.

## LOG-049 — 27.10.2026: общий native mutation boundary

LOG-049 / ROB-764 In Progress: общий native ORM запрещает CRUD/merge/batch
для omni-owned Message, Thread, Participant, Association, FolderAssociation и Target.
Проверяются сохранённые и новые родители; bypass/skipEvents не дают разрешения.
Доменный writer получает capability только на выданный активный strict scope,
тот же executor/workspace/repository и exclusive ownership fence. Все workspace
transactions берут shared fence до row locks; bootstrap/history/sent — exclusive.
Полный прогон: 1578 Jest /64 suites, 1567 PASS и 11 ошибок старого reconciliation
fixture. После исправления только подготовки данных весь затронутый suite:
18/18 PASS. Production source между прогонами неизменен, хеши сверены.
74 новых PostgreSQL случая; 20 dependency +6 checksum tests PASS.
Typecheck 208 roots: 146 baseline/current,0 новых/0 changed-code diagnostics.
[Доказательства и границы](implementation/log049/README.md). Миграции не менялись.
Далее — защита удаления CRM-родителей и проверка каскадных действий БД (T05/T22).
ROB-764 не закрыт; публичный API, UI, собственный ACL и автоматизация ещё впереди.
Демо прежнее, GitHub Actions не используется.

Два независимых scoped read-only review выявили необходимость раннего shared
fence, группировки OR с captured IDs и проверки обоих родителей folder junction.
Исправления включены, конкурентные и пять folder regression cases проходят.
Начальные fixture ошибки (enum/target field/owner DB role) исправлены; старые
cleanup/reconciliation fixtures создают protected graph через выданный typed
scope, сами проверяемые cleaner/rematch продолжают работать без capability.
Новый QueryExecutor type import нарушал dependency boundary; заменён opaque
object identity. Отдельная baseline ошибка TypeScript в прежнем aggregate method
не изменилась; в aggregate изменены только две опции ownership lock.
Полный Claude review не повторялся. Применены ai-dev-workflow,
behavioral-guardrails, server-schrodinger. Следующий шаг — parent hard-delete
guard, core retained references и trash cleanup без starvation; own ACL/audit
расширение не объявляется завершённым по этому guard.

Публикация LOG-049: код 0aa5e4312253336aa3668d4b5372c3400e289858, remote проверен GitHub API. Описание ROB-764 и комментарий ddec6696-e23c-49fb-b215-f3eee872a910 прочитаны обратно; все 11 статусов сохранены. Далее parent lifecycle guard.

## LOG-050 — 27.10.2026: защита родителей и очистка корзины

LOG-050 / ROB-764 In Progress: generic hard-delete защищает retained core targets,
ExternalIdentity и native references Person/Company/Opportunity/MessageCampaign.
Проверка выполняется под ownership fence и parent row locks, независимо от bypass,
skipEvents и native capability. Обычные email FK и WorkspaceMember SET NULL сохранены.
Корзина пропускает protected records, двигает точный PostgreSQL (deletedAt,id) cursor
и повторно проверяет retention после lock; concurrent restore не удаляется.
Полный набор: 1604 Jest /65 suites +26 guards =
1630 PASS; 26 новых PostgreSQL случаев. Typecheck 211 roots:
146 baseline/current,0 новых/0 changed-code. Все7 migrations неизменны.
[Доказательства и границы](implementation/log050/README.md). Scoped independent review: замечание о
микросекундах исправлено и проверено. Полный Claude pass не повторялся.
Далее — запрет workspace deletion до первого side effect и гонки metadata/first bootstrap.
ROB-764 не закрыт; разрешённый domain destroy, публичный API, ACL и UI ещё впереди.
Демо прежнее, GitHub Actions не используется.

Первый targeted прогон дал 211 PASS и одну ошибку подготовки WorkspaceMember:
не задан обязательный userId. Typecheck выявил sync callback fixture.withContext.
Оба test fixture исправлены. Independent review нашёл потерю микросекунд pg Date
в trash cursor; теперь берём deletedAt::text из той же выборки. Полная страница1000
protected records с ...000123Z, следующий ordinary record, одинаковые даты и
concurrent restore проверены. Native ownership finder общий для assert и partition;
нет отдельной ослабленной копии правил для очистки.
Dependency guard отклонил новый import getWorkspaceContext в TrashCleanup;
metadataId теперь берётся из уже загруженного flat metadata, baseline не меняли.
Финальный full suite и focused typecheck на неизменном source успешны.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Review
следующего T22 inventory подтвердил workspace DROP SCHEMA перед поздним core FK
RESTRICT и гонку metadata check/write с первым bootstrap; эти пути ещё не закрыты.
Нельзя считать ни ROB-764, ни полный аудит/ACL готовыми. Исправлена неточность
матрицы приёмки: identity/Person relation уже есть, explicit target projector ещё нет.

Публикация LOG-050: код 6a4cc84b40683d19f82dff362d0dc2373a887c17, remote проверен GitHub API. Описание ROB-764 и комментарий c3ebd531-91b3-4c8a-be8f-6719fbc1b7a6 прочитаны обратно; все 11 статусов сохранены. Продолжаем workspace lifecycle guard.

## LOG-051 — 28.10.2026: защита удаления рабочей области

LOG-051 / ROB-764 In Progress: WorkspaceService отказывает при retained omni данных
до membership/uninstall/schema/file effects. Короткая транзакция сохраняет deletedAt
под ownership fence; bootstrap проверяет эту отметку до первого INSERT. Direct DROP
SCHEMA требует ту же проверку и ранее сохранённую отметку удаления. Повтор сохраняет
дату, ошибки очистки не возвращают область в активное состояние.
Полный набор: 1635 Jest /67 suites +26 guards =
1661 PASS; 18 новых PostgreSQL и 13 owner-level случаев. Typecheck
216 roots: 162 baseline/current, 0 новых/0 changed-code. Все7 migrations неизменны.
[Доказательства и границы](implementation/log051/README.md). Scoped independent review: blockers не найдены;
полный Claude pass не повторялся. Далее — metadata check/write против first bootstrap
и итоговый T22 inventory. ROB-764 не закрыт; controlled purge, публичный API, ACL и UI
ещё впереди. Демо прежнее, GitHub Actions не используется.

Первый targeted запуск: 113 PASS, 7 FAIL. Причина подтверждена в текущем
PostgresQueryRunner: UPDATE RETURNING возвращает [rows, affected], а не rows.
Исправлена обработка результата с проверкой affected=1; финальные проверки успешны.
Для owner tests изолированы unrelated DI/AI ESM imports, реальные методы
WorkspaceService/WorkspaceSchemaService/DestroySoftDeletedWorkspaceJob исполнены.
Scoped review предложил сохранить исходный unknown outcome при ошибке cache:
теперь AggregateError сохраняет обе причины, дальнейшая очистка не начинается.
Проверены оба порядка bootstrap/delete на PostgreSQL, immutable deletedAt retry,
недоступность retained catalog, потеря COMMIT ACK, уничтожение соединения после
неподтверждённого rollback, direct schema DROP, billing/hook/cache failures.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Живой экземпляр
и коннекторы не менялись; отдельный стенд — только уже существующая isolated CI-среда.
Оставшийся риск metadata check/write подтверждён по коду. archivedAt не подходит как
самостоятельная необратимая резервация: штатный reconnect его снимает. Следующая
порция закроет чистые DB mutations, затем network lifecycle без длинной transaction.

Публикация LOG-051: код 52c4677015184002463aeb87859c9c14f1e26712, remote проверен GitHub API. Описание ROB-764 и комментарий 73c43b11-270b-4341-8b26-a85fad977a7c прочитаны обратно; все11 статусов сохранены. Продолжаем metadata transaction guards.

## LOG-052 — 28.10.2026: атомарные изменения metadata

LOG-052 / ROB-764 In Progress: чистые DB mutations ConnectedAccount.update,
MessageChannel.create/update/delete и APP channel create/update/delete выполняют
ownership check и запись в одной READ COMMITTED transaction под shared native fence.
Account locks предшествуют channel lock; parent и APP permissions читаются заново.
Create relation objects запрещены, delete event публикуется только после commit.
Проверено 244 targeted Jest /9 suites +26 guards =270 PASS, 29 новых PostgreSQL
случаев; typecheck219 roots:162 baseline/current,0 новых/changed-code. Все7 migrations
неизменны. Полный1635-test прогон LOG051 относится к предыдущему снимку; здесь не повторялся.
[Доказательства и границы](implementation/log052/README.md). Independent review выявил различимые APP ошибки:
исправлено и проверено. Полный Claude pass не повторялся.
Далее network lifecycle/reconnect, resolver side effects и итоговый T22 inventory.
ROB-764 остаётся In Progress; публичные API, ACL, UI и транспорт ещё впереди.
Демо прежнее, GitHub Actions не используется.

Первый новый PG run:66 PASS/2 FAIL из-за отсутствующего UUID DEFAULT в test core table.
Fixture приведён к native id generation. Первичная typecheck нашла только union
Promise в test capture; helper теперь принимает Promise<unknown>. Review обнаружил
разные APP create ошибки для missing и чужого account: typed missing-parent error
нормализуется в прежний ownershipViolation; paired PG test проверяет missing,
foreign-workspace и foreign-app одинаково. Postcommit observation, lost ACK и SQL
permission failure проверены. 44 старых owner tests адаптированы к transaction
manager; ownership assertions сохранены. Baseline dependencies не ослаблены.
Оставшиеся подтверждённые границы: network hooks/revoke нельзя завернуть в длинную
transaction; archivedAt снимается reconnect и не является irreversible reservation.
Generic resolver до update отдельно меняет pendingGroupEmailsAction. APP-only
bootstrap + immutable provider identity рассматривается для следующего contract
уточнения вместе со stale reconnect guards; пока не реализовано/не объявлено готовым.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Affected tests
выбраны по metadata/bootstrap/native guard зависимостям; полный предыдущий suite
не выдаётся за полный прогон текущего снимка. Демо/коннекторы не менялись.


Дополнительная проверка до публикации: фактический TypeORM0.3.31 EntityManager.transaction
глотает rollback error и возвращает connection через release. Для новых locks это
могло оставить открытый transaction в pool. Проверенный LOG051 owner вынесен в общий
omni-core-transaction; metadata использует свежий QueryRunner и runner.manager,
workspace wrapper сохраняет прежний UnknownError. READ COMMITTED явный, commit/release
unknown типизирован, rollback failure агрегирует причины и уничтожает connection.
Новый PG case подтверждает освобождение account lock запросом второго connection;
lost ACK не вызывает success event. Extraction отдельно просмотрена, blockers не найдены.
Финальный affected run244/9 +26 guards=270 PASS; typecheck219 roots162/162,0new/changed.

Публикация LOG-052: код 85054d1d33c477dc7793a482bb1e5af5f69ead57, remote проверен GitHub API. Описание ROB-764 и комментарий 37f43863-e63a-4eac-a091-add606506683 прочитаны обратно; все11 статусов сохранены. Продолжаем network lifecycle/reconnect guards.


## LOG-053 — provider identity, reconnect и старые привязки (28.10.2026)

Пути записи провайдеров разделяют создание и повторную авторизацию: Google/
Microsoft и IMAP используют INSERT для нового id, conditional UPDATE для прежнего.
SSO/token refresh/aliases сравнивают полный identity/custodian. APP OAuth сохраняет
shared reconnect и external account pinning; SQL одновременно проверяет текущую
доступность caller и принадлежность приложению/provider. Incomplete identity,
affected!=1 и unreadable binding storage дают ошибку без fallback/upsert.
Native APP не попадает в ordinary refresh/alias drivers. Immutable generic identity
и APP-only bootstrap дополняются retained-binding исключением для старых данных.

279 Jest /9 suites +26 guards=305 PASS;39 новых PG owner cases,
10 identity/bootstrap cases. Один прежний APP applicationId mutation-race case
заменён проверками запрета такого изменения; scope/custodian race cases сохранены.
Typecheck230 roots:198/197,0new/changed; migration hashes неизменны.
Начальные проверки нашли неверный регистр provider и старую fixture без поля,
review/typecheck — лишние account поля в channel UPDATE; исправлено. Review выявил
legacy provider binding, добавлены NOT EXISTS и реальные PG cases. Новый импорт
shared types barrel отвергнут dependency guard; структурный helper сохраняет тип
provider вызывающего кода, не импортируя Enterprise-reaching barrel. Pre-existing
IMAP catch error?.message заменён корректным narrowing; новая диагностическая
ошибка не скрыта исключением из typecheck. Финальный scoped review без blockers.

[Evidence](implementation/log053/README.md). Полный ROB-764 и full server typecheck не завершены.
Далее disconnect/transfer/deleteMany под актуальной ownership проверкой, resolver
pendingGroupEmailsAction и T22 inventory. ACL/UI/transport остаются в своих этапах.
Демо, SaleBot, Telegram/MAX не менялись; GitHub Actions не использовался.
Skills: ранее применённые ai-dev-workflow (bounded independent read-only review),
behavioral-guardrails и server-schrodinger; новые skills не заявляются.

LOG053 опубликован: d4d60d5d2479130d7591482bff5a6316565b4a16; GitHub remote проверен API. Linear description/comment 34d19f8a-8f5e-4e77-a3f6-a9838aafc389 и11 состояний проекта прочитаны обратно: совпали. [Публикация](implementation/log053/publication.json).


## LOG-054 — account lifecycle final DB ownership (28.10.2026)

Disconnect/transfer/deleteMany используют strict fresh transaction owner LOG052:
shared native fence → ordered account FOR UPDATE → persisted ownership → final DB
mutation. Native APP/null-ID не вызывает обычных provider adapters. Ordinary hooks
остаются вне transaction, проверена reentry в metadata без deadlock. Transfer
сверяет from custodian и affected count; ошибка откатывает весь DB batch. Delete
собирает актуальные child IDs после hooks; channel/calendar rows FOR UPDATE
удерживаются до cascade DELETE. Events только после подтверждённого commit.

224 tests/7 suites +26 guards=250 PASS.25 новых PG cases:
оба порядка bootstrap/lifecycle, native/ordinary/legacy/mixed behavior, rollback,
custodian race, hook reentry, reparent/create child во время hooks, actual calendar
concurrent reparent, second-connection postcommit visibility, lost ACK no success.
Typecheck230 roots:197/197,0new/changed-code;7 migration sources unchanged.
Initial6 failures были test interception: first QueryRunner принадлежал чтению до
transaction. Test barriers теперь ловят реальную active transaction; fault injection
действительно достигает final DB writer. Review нашёл calendar reparent после
SELECT — добавлены child locks и оба порядка actual-owner PG regression.

[Evidence](implementation/log054/README.md). Whole ROB-764 не закрыт. Остались
[background metadata writers](implementation/rob764-metadata-writer-inventory.md) и resolver side
effects; существующие ordinary remote actions не становятся транзакционными.
Network effect уже мог выполниться до локального отказа: не повторять автоматически.
Полный Claude pass/full server typecheck не заявляются. Демо/SaleBot/transports без
изменений, GitHub Actions не использовался. Применены прежние ai-dev-workflow,
behavioral-guardrails/server-schrodinger; scoped independent review read-only.

LOG054 опубликован: 4e9ccbb4a273669e01f2950162ae3b0bfc8f37a8; GitHub remote проверен API. Linear description/comment fd236bc4-0f9d-44f4-ab68-ded51355d2d7 и11 состояний проекта прочитаны обратно: совпали. [Публикация](implementation/log054/publication.json).


## LOG-055 — webhook final write ownership (28.10.2026)

Claim/settle/clear/markActive/Failed/Expired/reset для message/calendar используют
strict fresh transaction: shared fence → account/share + channel/update lock →
полная ownership проверка → same-manager update. Native APP/null IDs отклоняется
даже без binding. Retained legacy provider и derived account ownership защищены.
Workspace передаётся из всех callers; прежние claim/clientState/subscription CAS
сохранены. Из snapshot передаётся expectedConnectedAccountId: reparent до claim
не вызывает HTTP, reparent во время HTTP не записывает результат прежнего account.

Provider HTTP остаётся вне SQL transaction. Renew/delete сохраняют локальный
результат вне provider catch: потерянный commit ACK не запускает FAILED/recovery
и не выдаёт ложных success/failure metrics. Existing create orphan-watch cleanup
сохранён; автоматического повторного provider запроса не добавлено.

278 tests/6 suites +26 guards=304 PASS.
85 новых PostgreSQL cases: ordinary/native/legacy, missing/wrong workspace, claim
concurrency/CAS, denied ownership read, lock acquisition reparent, actual create/
renew/delete late callbacks, preclaim reparent и real commit-ACK loss. Driver HTTP
подменён; локальные services/repositories/locks/PostgreSQL реальные.
Typecheck236 roots:197/197,0 new/changed-code.7 migration sources unchanged.
Первый запуск нового набора упал на загрузке unrelated AI ESM через driver factory;
fixture теперь подменяет factory, сами проверяемые services остаются реальными.
Scoped review нашёл unknown-commit recovery и ordinary reparent; оба исправлены,
повторный scoped review без блокеров. Full Claude/full server typecheck не заявлены.

[Evidence](implementation/log055/README.md). Остались [sync/cursor/folder owners](implementation/rob764-metadata-writer-inventory.md),
resolver atomicity и итоговый T22/ROB764 acceptance. External effect может уже
состояться до локального отказа; SQL rollback его не отменяет. Демо не менялось.
GitHub Actions не использовался. Прежние skills ai-dev-workflow,
behavioral-guardrails/server-schrodinger; independent scoped review read-only.

LOG055 publication: code `73ade32887884f514f33bfc42b969858c3bfc96e`, remote head verified via GitHub API. Linear description/comment `a698dc36-11c8-4ca6-9c38-0cab7b93a108` read back;11 project states verified. [Publication](implementation/log055/publication.json).


## LOG-056 — atomic ordinary sync-status batches (28.10.2026)

Новый batch owner фиксирует input IDs до await, берёт shared ownership fence,
все account locks по sorted IDs, затем все channel locks; повторно читает parents
и полную ownership. Native APP/null IDs, retained/derived owned accounts и
reparented rows исключаются. AuthFailed сразу берёт account FOR UPDATE, без
SHARE→UPDATE upgrade. Реально изменённые rows определяют postcommit effects.

Message reset объединяет channel stage/cursor/throttle и ordinary folder reset
через withManager; folders дополнительно блокируются и проверяются по ownership.
Message/calendar authentication failure обновляет account и channel атомарно.
Cache, metrics, broadcast и reconnect используют только committed accepted IDs;
recipient/account берутся из locked snapshot, не из позднего чтения нового parent.
Microsoft reconnect reset вынесен за persistence transaction и получает channel IDs.

Ревью обнаружило local unknown COMMIT → import recovery и stale account authFailure.
Оба исправлены: ранний rethrow в handlers и messaging catch до setAdd; captured
account ID в credential/certificate failure. Новые66 PG cases включают actual import
owners lost ACK, actual handlers stale parent, mixed/native/legacy/derived owners,
parallel reversed batches, SQL rollback, folder reset, conditional scheduling,
input snapshot, tenant mismatch и unreadable ownership.7 старых mock reset cases
заменены PostgreSQL проверками. Microsoft existing caller regression проверяет
committed account/channel state во время reset и настоящий channel ID.

Affected 332 tests/7 suites; full fork 1881/71 +26 guards=1907 PASS.
Typecheck242 roots:197/191,0 new/changed-code;7 migration sources unchanged.
Initial fixture failures: unrelated AI import, missing folder table/archivedAt;
исправлены fixture boundary/schema. Type pass потребовал нормализовать unknown
exception и убрать union-repository enum ambiguity в тесте. Полный server typecheck
и полный Claude review не заявляются. Scoped re-review без новых блокеров.

[Evidence](implementation/log056/README.md). [Inventory](implementation/rob764-metadata-writer-inventory.md) сохраняет
оставшиеся group/resolver/cursor/throttle/folder writers. Это не атомарность всех
старых внешних side effects, не закрытие ROB764 и не транспорт. Демо/SaleBot прежние.
GitHub Actions не использовался; skills ai-dev-workflow, behavioral-guardrails,
server-schrodinger, независимое scoped review read-only.

LOG-056 publication: code 7c1a2277120f43ebb7dbfc9ab43618fa21be9a2e pushed; GitHub ref verified through API. Linear comment f73921aa-a706-4837-9d40-2bfce4d7aec3; description/comment and all11 project states independently read back. ROB-764 In Progress. See implementation/log056/publication.json.


## LOG-057 — cursor final writes and atomic channel settings (28.10.2026)

MessagingCursorService фиксирует channel/parent/cursor/folder до await. Existing
single-channel owner блокирует account/channel и исключает fresh native ownership.
Numeric cursor сравнивается с текущей DB строкой, поэтому stale input не откатывает
его назад. Folder write проверяет exact parent, блокирует folder и проверяет полную
ownership; channel throttle/stage reset использует тот же manager и rollback.

Resolver сохраняет раннюю авторизацию, затем передаёт settingsCaller в metadata
update. Под блокировкой повторяются current parent/type/busy проверки и существующая
isAdministrableByCaller по актуальным scope/custodian/provider. Настройка и derived
pendingGroupEmailsAction пишутся одним UPDATE. EMAIL_GROUP/PENDING_CONFIGURATION/
unchanged-value semantics сохранены. Неиспользуемый standalone marker удалён.

Review нашёл same-account custodian/scope race; исправлен final authorization по
locked account, реальные отрицательные PG кейсы добавлены. Scoped re-review без
новых блокеров. Это не собственный ACL и не глобальная блокировка изменений ролей
(ROB766). Worker cleanup/finalizers ещё остаются в inventory.

Проверки: 203 targeted Jest/6 suites +26 guards = 229 PASS;
22 новых PostgreSQL cases. Typecheck 247 roots: 191 baseline/191 current,
0 new/changed-code. Одна baseline diagnostic в неизменённом worker method сохранена.
Guard отклонил лишний type import с транзитивным Enterprise path; удалён, тип берётся
из аргумента уже используемого метода. Guard повторно PASS, 7 migrations неизменны.
Full suite не повторялся: последний LOG056 1881/71. Локальные и тестовые LF hashes
сверены. Полный server typecheck, Claude pass и ROB764 acceptance не заявляются.

[Evidence](implementation/log057/README.md). [Remaining writers](implementation/rob764-metadata-writer-inventory.md).
Демо/SaleBot не менялись; GitHub Actions не использовался. Применён ai-dev-workflow,
behavioral-guardrails, server-schrodinger и read-only scoped review.

LOG-057 publication: code 230f274d422b56c9df25a958ee331ccbc8cff38d pushed; GitHub ref verified through API. Linear comment eb7eaaa1-c597-40ac-b138-bdd3d0ebb413; description/comment and all11 project states independently read back. ROB-764 In Progress. See implementation/log057/publication.json.


## LOG-058 — atomic temporary failure, import completion, relaunch and CLI (28.10.2026)

Message/calendar temporary failures передают captured account в ordinary owner.
Fresh throttle count, threshold, retryAfter и retry/failed stage вычисляются под
account/channel locks и записываются одним UPDATE. Поведение порога5 сохранено:
count4→5 retry, следующая ошибка→FAILED. Stage start сохраняется. Cache, broadcasts
и metrics следуют только за известным commit; stale/native callback ничего не пишет.
Handlers больше не выполняют собственные раздельные increment/status transactions.

Промежуточный message import объединяет pending и throttle/stage reset. Last/empty
completion возвращает admission result и закрепляет parent; отклонённый completion
не объявляется успешным. Ревью нашло zero-message list-fetch callsite без parent:
исправлен и проверен через actual service с reparent во время getMessageLists.
Предшествующий legacy list-fetch cache clear этим не стал транзакционным: тест
явно сохраняет1 intermediate clear и запрещает чужой final completion/metrics.

Message/calendar relaunch выполняет актуальный FAILED/FAILED_UNKNOWN CAS под
ordinary owner. CLI и status service используют одну выделенную scheduling
операцию; очередь получает только committed returned IDs. Native/protected и
отключённые каналы исключаются. Unknown commit не вызывает enqueue.

Проверки: 279 targeted Jest/6 suites +26 guards = 305 PASS;
24 новых PG cases: parallel threshold, stale snapshot/parent, bound/unbound native,
SQL rollback, lost ACK, actual handlers/relaunch/CLI/list-fetch completion.
Первый прогон276/278 выявил реальный неверный разбор raw UPDATE результата TypeORM:
[rows,count] вместо rows. Исправлено CTE с SELECT id, затем финальный прогон PASS.
Dependency guard отклонил2 лишних импорта; удалены без ослабления guard/baseline.
CLI переиспользует scheduling helper без новой зависимости от полного status service;
calendar handler передаёт isListFetch, enum выбирается в существующем status owner.
Typecheck 252 roots:191/191,0 new/changed-code;7 migrations неизменны.
Full fork последний в LOG056 (1881/71), здесь не повторялся. LF hashes совпали.
Scoped re-review без новых блокеров. Полный server typecheck/Claude pass/ROB764
acceptance не заявляются.

[Evidence](implementation/log058/README.md). [Remaining writers](implementation/rob764-metadata-writer-inventory.md).
Следующий coherent slice: group/folder metadata и destructive batches. Нельзя
держать новый core owner вокруг cleaner, открывающего собственную native transaction.
Демо/SaleBot не менялись; GitHub Actions не использовался. Применены ai-dev-workflow,
behavioral-guardrails, server-schrodinger и read-only scoped review.

LOG-058 publication: code 5a3f53a1e0d1381a60f2e937602fecb880c33113 pushed; GitHub ref verified through API. Linear comment 71477b48-b833-4ea8-bb41-5c00da480828; description/comment and all11 project states independently read back. ROB-764 In Progress. See implementation/log058/publication.json.


## LOG-059 — folder metadata transaction owner (28.10.2026)

MessageFolderMetadataService create/update/setSyncStatus/delete теперь используют
fresh ordinary account/channel ownership и folder lock в одном manager. Первичное
discovery родителей выполняется до owner, затем точная цепочка проверяется после
блокировок. Все родители захватываются в стабильном порядке до папок. Destination
при reparent входит в тот же lock set; native/retained/derived ownership запрещает
обычную мутацию. Mixed batch отклоняется полностью. Create проверяет также явный
folder ID после INSERT в той же транзакции; это не upsert.

Resolver сохраняет предварительную проверку и передаёт userWorkspaceId для повторной
проверки текущего владельца подключения после блокировки. Google-only backfill,
поведение pending IMPORT при disable и сохранение pending DELETION не изменены.
Relation/scope replacement запрещён. Unknown commit возвращается ошибкой, без
ложного подтверждения успеха. Возвращаемая запись прочитана тем же manager до commit.

Проверки: 226 targeted Jest/5 suites +26 guards = 252 PASS.
30 новых PG tests: CRUD, bound/unbound native, retained junction, mixed batch,
parent/custodian changes, bootstrap after discovery, reversed concurrent batches,
SQL rollback, unknown commit, unreadable ownership, scope mutation, Google/Microsoft.
Typecheck 256 roots:191/191,0 new/changed-code.
7 migrations неизменны, LF hashes совпали. Read-only scoped review без blockers.
Полный server typecheck и новый full fork/Claude pass не заявляются. Последний full
fork остаётся LOG056 (1881/71). ROB764 acceptance ещё не выполнен.

[Evidence](implementation/log059/README.md). [Remaining writers](implementation/rob764-metadata-writer-inventory.md).
Следующий шаг: group/folder destructive batches внутри существующей native transaction,
с captured parent/action и условным атомарным finalizer. Внешняя nested core transaction
вокруг cleaner не используется. Демо/SaleBot не менялись; GitHub Actions не использован.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger и scoped review.

LOG-059 publication: code 174ce7ca8528353185dc277d3875cc5da4018acd pushed; GitHub ref verified through API. Linear comment 52fbd366-cc19-4bd2-9692-4b70a75d60bd; description/comment and all11 project states independently read back. ROB-764 In Progress. See implementation/log059/publication.json.


## LOG-060 — guarded group-email cleanup and finalization (28.10.2026)

Group worker принимает текущий snapshot в коротком ordinary-channel owner:
parent, pending action, exclude setting и PostgreSQL updatedAt с6 микросекундными
знаками. Date из загруженной entity не используется. Snapshot является консервативной
проверкой принятой работы, а не отдельным монотонным revision counter.

Каждая порция cleaner в собственной native strict transaction после shared ownership
fence блокирует expected account → channel, проверяет snapshot и полный ownership.
Stale возвращает явный отказ; последующие порции и list-fetch прекращаются. Не открывается
внешняя core transaction вокруг native cleanup. Finalizer повторно проверяет snapshot,
блокирует папки и одним manager сбрасывает разрешённые folder cursors, channel cursor
и pending NONE. Protected junction folder исключается из reset. IMPORT не удаляет данные.

Атомарны отдельная destructive порция и отдельно finalizer. Уже committed порции
не откатываются при stale/error в следующей; pending/new action не стирается. Native
unknown outcome пробрасывается через import handler без ложного failure-state/cache.
Остальные cleaner call sites сохраняют прежний контракт без snapshot; этим не закрыта
вся folder/list-fetch cleanup lifecycle.

Проверено 189 targeted Jest/5 suites +26 guards=215 PASS.
22 новых PG cases: actual worker/cleaner, IMPORT, stale parent/action/settings/time,
ABA1µs, native/retained ownership, protected folder, read failure, SQL rollback,
native lost COMMIT ACK, exclusive enrollment fence,201-message chunks interrupted
by settings change, and actual list-fetch/exception-handler propagation.
Первый lost-ACK test incorrectly intercepted an earlier pool read and timed out;
injection moved immediately before cleaner transaction. Multi-chunk fixture initially
violated native unique(message,channel); corrected to distinct native messages.
Typecheck caught4 implicit-any callbacks in tests, corrected with explicit types.
Typecheck 259 roots:191/190,0 new/changed-code.
7 migrations unchanged; LF source hashes verified. Scoped read-only review clear.
Last full fork LOG0561881/71; no new full server typecheck/Claude pass or ROB764 acceptance.

[Evidence](implementation/log060/README.md). [Remaining writers](implementation/rob764-metadata-writer-inventory.md).
Next: folder destructive batch and finalizer sharing actual native scope; then sync
folder discovery and provider predicate. Demo/SaleBot unchanged, GitHub Actions unused.
Applied ai-dev-workflow, behavioral-guardrails, server-schrodinger and scoped review.

LOG-060 publication: code 693b3d96e3d6997b16d49e28b4fca4bf34992505 pushed; GitHub ref verified through API. Linear comment 45b18812-6a05-4f75-b28b-e4ee37624f35; description/comment and all11 project states independently read back. ROB-764 In Progress. See implementation/log060/publication.json.


## LOG-061 — folder action ownership, cleanup and Gmail selection (28.10.2026)

Folder worker captures current parent, pending action, synced state, external ID,
exact6 PostgreSQL folder/channel timestamps and complete folder hierarchy. It no
longer trusts the loaded folder name/hierarchy. Each deletion page holds ownership
fence and account/channel/folder locks, checks current action and performs native
association/message/thread/target cleanup plus folder-junction removal in the same
strict native transaction. A stale page returns explicit refusal and stops the action.

Deletion finalizer uses exclusive native ownership fence, rechecks token and all
remaining junctions (including deleted/unrelated channel rows), then deletes metadata.
Import finalizer compares the full hierarchy and resets pending action before returning
provider IDs. Unknown core/native commit propagates. Ordinary failures remain logged
with pending action preserved. Each page and finalizer is atomic separately; previously
committed pages survive later stale/error. Legacy three-argument low-level deletion
remains unchanged; production folder worker supplies the guarded action token.

Scoped review found two Gmail regressions: singleton folder input could enable a
whole-mailbox shortcut, and incomplete parent names could produce a partial label.
Worker now passes captured complete hierarchy; strict selected-folder mode bypasses
all-folder shortcuts and rejects missing/null/empty/whitespace parent names. Existing
non-strict Gmail callers retain their behavior. Re-review found no confirmed blockers.

226 targeted Jest/6 suites +13 Gmail/2 suites +26 guards=265 PASS.
37 new PostgreSQL cases cover actual worker/importer/cleaner, stale parent/action/
settings/time,1µs ABA, hierarchy drift, protected ownership, mixed requests,201-junction
interruption, rollback and unknown commit. Retired14 mock cases that asserted the old
metadata repository orchestration; real PG workflow coverage replaces them. A test
injection initially assumed a SQL string rather than pg QueryConfig; corrected and
re-run. Typecheck caught implicit parentId inference; explicit type fixed it.
Typecheck 265 roots:190/190,0 new/changed-code.
7 migrations unchanged; local/remote LF source hashes matched, deleted test absent.
Last full fork LOG0561881/71; no new full fork/full server typecheck/full Claude pass
or ROB764 acceptance claimed. Deployment and client acceptance remain separate.

[Evidence](implementation/log061/README.md). [Remaining writers](implementation/rob764-metadata-writer-inventory.md).
Next: sync-folder discovery, derived provider ownership and final T22/acceptance.
Demo/SaleBot unchanged; GitHub Actions unused. Applied ai-dev-workflow,
behavioral-guardrails, server-schrodinger and scoped read-only review.

LOG-061 publication: complete code be4ae869a74e43c5aedb5a07ce627ff8ad2f8c86 pushed; GitHub ref verified through API. Evidence/test retirement was published immediately before it in4fb54bfc because the deleted-path staging rejected the first source list; history was not rewritten. Linear comment08af6696-01d6-4dc1-958d-2a7c1182b11a; description/comment and all11 project states independently read back. ROB764 In Progress. See implementation/log061/publication.json.


## LOG-062 — guarded folder discovery reconciliation (28.10.2026)

Research confirmed SyncMessageFoldersService applied provider responses using the
caller's stale folder list through separate repository writes. Its synthetic return
projection also replaced retained pending IMPORT/DELETION with NONE. Four callers
were checked: list-fetch consumes results; Google/Microsoft/IMAP initial sync ignores
them and runs after account transaction. The selected minimal boundary reuses the
existing ordinary-channel owner and scoped repository.withManager; no new schema.

Before network: fresh ownership, account/channel/folder locks and exact6 versions,
current account identity/import policy/folder rows. During network: no open transaction.
After response: repeat the same owner and reject changed snapshot, then compute delta,
write every folder through the same manager and return actual rows after known commit.
Folder-set changes reject stale discovery rather than deleting newly created folders.
Pending actions remain as stored. Null stops list-fetch before subsequent provider,
cache and completion effects. Existing markAsMessagesListFetchOngoing precedes
discovery and is not rolled back by a later null result.

Scoped review identified same-account IMAP endpoint replacement while old discovery
was running. Snapshot now conservatively includes full connectionParameters and
externalAccountId, while OAuth token refresh remains excluded. Regression verifies
old endpoint response refusal; re-review found no confirmed blockers. IMAP initial
sync explicitly rethrows core unknown commit; ordinary provider failure warning remains.

236 targeted Jest/5 suites +26 guards=262 PASS.
35 new discovery PG cases plus3 actual caller regressions cover current readback,
pending actions,3 provider dispatches, parent/policy/identity/endpoint changes,
folder-set changes, ownership introduction, protected junction, permission failure,
SQL rollback, lost commit ACK and concurrent duplicate prevention. Initial2 failures
were missing UUID-default in the minimal test table; fixture corrected to match the
real generated-ID schema. No production migration was necessary.
Typecheck 267 roots:190/190,0 new/changed-code.
7 migrations unchanged; source LF hashes matched. Last full fork LOG0561881/71;
no new full fork/full server typecheck/full Claude pass or ROB764 acceptance claimed.

[Evidence](implementation/log062/README.md). [Remaining writers](implementation/rob764-metadata-writer-inventory.md).
Next: derived provider ownership with actual writer serialization, then remaining
list-fetch cache/cleanup boundaries and final T22 acceptance. Demo/SaleBot unchanged,
GitHub Actions unused. Applied ai-dev-workflow, behavioral-guardrails,
server-schrodinger and scoped read-only review.

LOG-062 publication: code aa40ea54b4611666a6ed842673b4e7067e34d3a7 pushed; GitHub ref verified through API. Linear comment d736f145-369a-43ef-b47a-0659c29f47ee; description/comment and all11 project states independently read back. ROB764 In Progress. See implementation/log062/publication.json.


## LOG-063 — provider writes under complete metadata ownership (28.10.2026)

Research confirmed direct retained-binding Raw predicate did not cover MessageLink,
Conversation or another bound association. Merely duplicating that SQL would not
serialize first ownership introduction. Reused findOmniOwnedConnectedAccountIds with
the existing shared native fence and account FOR UPDATE, preserving identity WHERE
and affected===1. The direct Raw predicate remains an additional check, not the owner.

Seven actual writers: create-existing, reconnect update, IMAP, SSO, refresh, aliases,
app OAuth. Google/MS/IMAP use one strict outer owner; create/reconnect helpers use its
manager, no nesting. New-account paths retain INSERT/PK collision refusal. SSO merges
fresh scopes under lock. Refresh and alias network work stays outside transaction;
caller identity is captured before awaits. App OAuth retains authorized shared-account
reconnect by another custodian and external-account pinning; UPDATE/readback share
the same manager. Google reconnect-list cleanup moved after known commit.

Unknown commit propagates without new returned tokens/aliases. Application connection
mapping no longer turns an unknown refresh commit into successful null fallback.
Scoped review found IMAP archived re-enable by old channel ID could affect a reparented
message/calendar channel; both UPDATEs now pin captured parent. Regression and re-review
confirm the fix. Missing-account error contract remains CONNECTED_ACCOUNT_CHANGED.

342 targeted Jest/6 suites +26 guards=368 PASS.
45 new cases:28 seven-writer×derived-marker checks,7 lost-ACK writers, mutable caller,
both shared/exclusive fence directions, fresh SSO scopes, application-mapping error,
IMAP child reparent, and4 actual Google/MS outer rollback/unknown-commit checks.
44 use real PostgreSQL;1 checks the application mapping boundary. Initial2 regressions
were missing-account error wording and were fixed without weakening the guard.
Typecheck found SSO JSON insert typing and test enum literal; corrected and rerun.
Typecheck 269 roots:190/190,0 new/changed-code.
7 migration sources unchanged; local/remote LF hashes matched. Last full fork LOG056
1881/71; no new full fork/full server typecheck/full Claude pass or ROB764 acceptance.

Postcommit reconnect reset/enqueue still needs captured-parent/accepted-ID handling;
it is not covered by the preceding account transaction. Later list-fetch cache/cleanup
also remains separate. No claim of atomic Redis/SQL effects or arbitrary raw SQL safety.
[Evidence](implementation/log063/README.md). [Remaining writers](implementation/rob764-metadata-writer-inventory.md).
Next: those callbacks, then T22 inventory and fresh stage acceptance. Demo/SaleBot
unchanged, GitHub Actions unused. Applied ai-dev-workflow, behavioral-guardrails,
server-schrodinger and scoped read-only review.

LOG063 publication: code 466051dfe02277e2934fbb7a0c0f1049ab09b011 pushed and GitHub API ref verified; Linear comment 83ae5013-808e-4de1-aacc-d79a833d0891, description/comment and all11 project states independently read back. ROB764 remains In Progress.


## LOG-064 — reconnect scheduling and queued parent admission (28.10.2026)

Reconnect formerly reset to PENDING then enqueued jobs requiring SCHEDULED. New
resetAndSchedule methods atomically reset cursors/folders and set SCHEDULED/ONGOING
under the existing ordinary owner, with captured parent and fresh enabled/non-
PENDING_CONFIGURATION predicates. Existing reset-to-pending callers retain their
default behavior; optional expected-parent and returned accepted IDs are additive.
Google/MS/IMAP enqueue only accepted IDs with expectedConnectedAccountId. MS no
longer unconditionally resets old snapshots, including channels awaiting setup.
Both list-fetch jobs reread channel/account under full ordinary ownership with
expected parent and enabled predicate. Legacy payloads remain accepted but receive
the same current ownership check. Provider network stays outside DB transactions.
Unknown reset/admission commit prevents success IDs, cache/broadcast/provider calls.

372 targeted Jest/6 suites +26 guards=398 PASS;
30 new PG cases:24 reset/job admission (parent/disabled/configuration/owned, mixed
IDs, ordinary flow, unknown ACK) and6 actual Google/MS/IMAP caller routing checks.
Typecheck 269 roots:190/190,0 new/changed-code.7 migration sources unchanged.
Scoped read-only review found no substantive blockers; reviewer did not run tests.
Initial test harness issues fixed: CalDAV ESM loading excluded at provider boundary,
existing list-job class mock removed, native bootstrap fixture given APP provider,
uniform it.each tuple arity prevents done-callback timeouts, enum union fixed.

The current parent read is an admission snapshot, not a lock across provider/cache
work. Current channel-only Redis keys still need account provenance to protect a
reparent after SQL commit. Source inventory also found direct import-cron scheduling;
it joins downstream list-fetch/import/cache work next. Webhook/onboarding callbacks
keep their own lifecycle contracts; no claim of whole reconnect cross-store atomicity.
Last full fork LOG0561881/71; no full fork/full server typecheck/full Claude pass or
ROB764 acceptance claimed. [Evidence](implementation/log064/README.md).
Demo/transport unchanged; GitHub Actions unused. Applied ai-dev-workflow,
behavioral-guardrails, server-schrodinger and scoped read-only research/review.

LOG064 publication: code a97e94ed0dc5f8b8411e711f3eb316938e871d23 pushed and GitHub API ref verified; Linear comment acff0f76-80d4-4fd3-899b-2cc5d19486c0, description/comment and all11 project states independently read back. ROB764 remains In Progress.


## LOG-065 — account-scoped message import cache (28.10.2026)

All five runtime key owners now use one validated canonical UUID helper:
list-fetch, batch importer, sync-status/progress, recent-message onboarding and
clean-cache job. Pending/total/imported v2 keys include workspace/channel/account.
Producers capture namespace before provider await; importer copies caller identity
before awaits and requeues failures only into its captured namespace. Reset/clear/
broadcast use accepted SQL account descriptors, never a later parent lookup.
Public progress reads a current ordinary channel before selecting its namespace;
missing/protected returns null. Old cleanup payloads only delete legacy keys.
One shared7-day TTL is used by producers, error requeue and counter expiry; Redis
operations remain separate, not an atomic TTL/SQL protocol.

Retained legacy backlog (pending set or either counter) causes guarded cursor reset
to list-fetch pending before import/pop/completed. Pending group/folder actions are
preserved. Only known commit permits old-key deletion. Stale parent/disabled/setup
returns stop without deleting the backlog; unknown commit propagates. No dual-read
or reassignment of unknown-origin IDs. This recovery requires surviving legacy keys;
it cannot discover queues already expired/deleted before upgrade. New keys do not
isolate overlapping requests for the same account; downstream snapshot guards next.

388 targeted Jest/6 suites +26 guards=414 PASS.
16 new cases:13 SQL/caller boundaries plus3 pure-key/cleanup cases. Include delayed
list-fetch/onboarding responses after reparent, captured postcommit reset, current
progress, legacy refetch/pending actions/stale/unknown outcomes, actual importer
early stop and account-pinned requeue TTL. Cache is a controlled test double; these
cases do not claim real Redis atomicity. Initial TTL import referenced a nonexistent
shared export; the regression caught undefined TTL, replaced with the canonical
common constant and reran successfully. Runtime behavior tested against real PG
where stated. Typecheck 269 roots:190/189,0 new/changed-code.
7 migration sources unchanged; source LF hashes matched. Scoped read-only review
found no new blockers, did not execute tests. [Evidence](implementation/log065/README.md).

Next: guarded import scheduling/current importer and onboarding admission, then
bounded list-response snapshot/SQL apply cleanup and fresh T22 acceptance. This does
not close response-to-write races or onboarding's existing broad catch. Last full
fork LOG0561881/71; no new full fork/full server typecheck/full Claude review or
ROB764 completion claimed. Demo/SaleBot unchanged; no Actions. Applied ai-dev-workflow,
behavioral-guardrails, server-schrodinger and scoped read-only research/review.

LOG065 publication: code e99085b8f7c2e06be8a0a8192c7ea6e4d1f06863 pushed and GitHub API ref verified; Linear comment 894dcf36-9a9b-43e3-8d4a-c64734ff1d09, description/comment and all11 project states independently read back. ROB764 remains In Progress.


## LOG-066 — scheduler and stale recovery admission (28.10.2026)

Generic ordinary metadata scheduling reuses shared ownership fence/account-channel
locks, rechecks enabled/pending in SQL, and returns accepted ID/account descriptors.
Three cron writers and calendar CLI enqueue only these descriptors after known
commit. The compatibility message scheduler retains its string[] contract.
Both import jobs accept expectedConnectedAccountId and read current ordinary
channel/account under the owner before stage/enabled checks and provider calls.
Legacy job payloads remain compatible through current-owner admission.
Both stale watchdogs re-read stage/start time under the owner before resetting;
message broadcasts happen after known commit and contain actual updated channels.
Network/provider calls do not hold DB locks. SQL commit plus queue is not atomic;
partial enqueue failure leaves scheduled rows for existing stale recovery.

434 targeted Jest/6 suites +26 guards=460 PASS;
46 new PostgreSQL cases:24 scheduler,10 watchdog,12 import-job cases. Includes
mixed protected rows, disabled/stage/enrollment changes after candidate reads,
unknown commit/no enqueue or broadcast, known commit/queue failure, parent changes
and legacy payloads. Initial direct UPDATE returned TypeORM [rows,count], not rows;
regression and independent review caught it. CTE SELECT restores flat descriptors.
Typed repository test doubles fix new test errors. Restored declared lodash.groupby
imports after review caught undeclared lodash imports; isolated type tools now include
the declared @types/lodash.groupby 4.6.9 for both baseline and current sources. Dependency guard initially rejected two new transitive edges
through the shared utils barrel. The pure stale helpers now use explicit null/undefined
checks with unchanged timeout/invalid-date behavior; baseline guard passed unchanged.
Typecheck 278 roots:191/189,0 new/changed-code;
7 migration checksums unchanged and remote LF source hashes matched.
Scoped read-only review final reread found no other blockers, did not run tests.
[Evidence](implementation/log066/README.md).

Existing message list-fetch cron/CLI payloads still lack expected account; member
blocklist reset loses selected owner provenance. Direct importer/onboarding and
provider-response-to-write lifecycle remain open. Candidate throttle/webhook checks
are not newly transactional; no full lifecycle or SQL/queue atomicity claim.
Last full fork LOG0561881/71; no full server typecheck/full Claude review/ROB764 Done.
Demo/SaleBot unchanged; no GitHub Actions. Skills: ai-dev-workflow,
behavioral-guardrails, server-schrodinger, scoped read-only research/review.

LOG066 publication: code c981f4951291ed55d012ac4d3810f7754cc9e9dc pushed; GitHub API ref verified. Linear comment 3cc03ec9-dd1c-4e74-84f8-127a11edbbd6, description/comment and all11 project states independently verified. ROB764 In Progress.


## LOG-067 — scheduled parent and member reset provenance (28.10.2026)

Internal message scheduler/status API now returns accepted ID/account descriptors;
all production callers updated. Cron/CLI enqueue the captured parent; webhook uses
a status-owned current ordinary enabled/SCHEDULED read after scheduling before
provider. No second unguarded account lookup or string-only identity handoff.
Member blocklist deletion retains account and UserWorkspace from discovery and
passes both into reset. Existing owner filters locked channel descriptors before
channel/folder UPDATE and actual-ID cache/broadcast. Global deletion supersedes
member selection, preserving workspace-wide behavior and avoiding duplicate reset.
Member batches are independent per-account transactions; a later failure does not
roll back previously committed accounts. Existing unscoped resets remain compatible.

2205 full fork Jest/75 suites +26 guards=2231 PASS.
28 new PG cases:6 message list cron,16 actual blocklist jobs,6 actual webhook service.
CLI existing case strengthened for captured parent. Tests cover parent/custodian
change after discovery, native enrollment, missing member, global overlap/transfer,
unknown commit/no effects and disabled/stage change before webhook provider.
Member lookup only uses a controlled WorkspaceMember stub; core account/channel,
reset transaction and persistence are real PostgreSQL. Earlier targeted462/6 passed;
final full suite verifies the final read method placement in status service.
Typecheck 282 roots:189/189,0 new/changed-code;
7 migration sources unchanged; source LF hashes matched. Dependency guard passed
without baseline exceptions. New shared types barrel edge in webhook was avoided
by keeping stage/read ownership inside the existing status service.
Scoped read-only review found no blockers, did not run tests. [Evidence](implementation/log067/README.md).

Next code inspection found calendar webhook direct status UPDATE and inline import
from IMPORT_PENDING. Guard/pin that caller before requiring SCHEDULED admission in
direct import services. Onboarding/list-fetch callbacks and native post-provider
save/delete remain open: native guards must run inside existing workspace transaction,
not around provider network or a nested transaction. Fresh full suite is regression
evidence, not full ROB764/CRM acceptance. No full server typecheck/full Claude review.
Demo/SaleBot unchanged; no Actions. Skills ai-dev-workflow, behavioral-guardrails,
server-schrodinger with narrow read-only research/review.

LOG067 publication: code 1408d41a9e46d7fa3c4d827d004bf13757ebf62f pushed; GitHub API ref verified. Linear comment abd3075b-4a4f-4456-9931-b01aa373fcdf, description/comment and all11 project states independently verified. Full fork2205/75 PASS; ROB764 In Progress.


## LOG-068 — notification account dispatch and calendar webhook orchestration (28.10.2026)

All eight Google/Microsoft notification trigger calls carry captured account through
queue payload/job. New dedup keys include account; legacy key/body remain unchanged
and separate from qualified keys. Workspace serviceability check still gates queue.
Optional scheduler expected parent is checked by the existing ordinary owner before
UPDATE, not merely after it. Message wrapper/status/webhook forward this pin.
Calendar direct scheduling replaced by generic ordinary scheduling plus fresh
parent/enabled/SCHEDULED read. The accepted account survives fetch. Inline import
requires same-parent IMPORT_PENDING→SCHEDULED and another current read. A resolved
fetch does not itself prove success: handled errors must not import old cache.
Empty/deferred cache behavior preserved. No transaction spans network/provider work.

568 targeted Jest/7 suites +26 guards=594 PASS.
21 new cases:16 actual calendar orchestration/SQL,1 old-parent message rejection,
4 queue dispatch/dedup contract cases with controlled enqueue. Provider/import are
controlled doubles, so no claim on internal fetch/import writes or real BullMQ
execution. Unknown initial/read/inline commit produces no next fetch/import;
parent/stage/disabled/native changes rejected. Legacy body/key compatibility tested.
Typecheck 290 roots:189/189,0 new/changed-code;
7 migrations unchanged, source LF hashes matched; dependency baseline unchanged.
Scoped review checked all callers and found no blockers, did not execute tests.
[Evidence](implementation/log068/README.md). Last full fork LOG0672205/75, no new full suite claim.

Remaining: CalendarFetchEventsService ongoing/pending/completed/cursor and native
cleanup after provider, shared calendar cache namespace, direct import/onboarding
admission, same-account run tokens and native apply. Microsoft renew/recreate
lifecycle calls need event parent/subscription pins independently of trigger pin.
The current change only protects scheduling/dispatch/orchestration. No full server
typecheck/full Claude review/ROB764 Done. Demo/SaleBot unchanged; no Actions.
Skills ai-dev-workflow, behavioral-guardrails, server-schrodinger, scoped read-only review.

LOG068 publication: code 5f7ff774081769c23afacd980bcc6ffb8843d7dc pushed; GitHub API ref verified. Linear comment 01ef640c-1405-4d13-b169-e439659133aa, description/comment and all11 project states independently verified. ROB764 In Progress.


## LOG-069 — account-scoped calendar cache and legacy refetch (28.10.2026)

All four calendar cache owners now use one UUID-validated normalized v2 key:
fetch producer, batch consumer, webhook count and status/reset flush. Fetch/import
copy caller identity and capture key before awaits; mismatched channel/account
fails before cache/provider. Postcommit flush uses accepted account descriptors.
Calendar retained legacy set causes guarded cursor reset/list-refetch before either
fetch or import. Recovery skips stale parent/disabled/setup/native/protected channels;
stop even on declined reset, and delete legacy only after known reset + v2 flush.
No legacy contents are adopted as belonging to the current account. Already lost
legacy backlog cannot be discovered. Existing cache TTL behavior is unchanged.
Cursor-error/notfound/unknown failure branches now carry snapshot parent into reset/
flush, completing account pin for these error paths alongside credentials/temporary.
This does not supply stage/run guards for successful provider callbacks/native apply.

587 targeted Jest/7 suites +26 guards=613 PASS.
19 new cases:18 PostgreSQL/caller boundaries and1 pure-key case. Includes retained
backlog/unknown outcomes, actual early-stop services, delayed producer after reparent,
postcommit clear after reparent, mutable caller identity, ordinary/stale-parent error
branches. Provider/cache doubles explicitly isolate their boundaries; no real Redis
atomicity or provider integration claim. Initial2 failures were Jest ESM loading of
CalDAV digest-fetch while loading actual fetch orchestration. Explicit provider-layer
mock matches the intended test boundary; actual fetch method and SQL owners remain
executed. Rerun passed. Typecheck 291 roots:189/188,0 new/changed-code;
7 migration sources unchanged, source LF hashes matched; guard baseline unchanged.
Scoped read-only review no blockers, reviewer did not run tests. [Evidence](implementation/log069/README.md).

Next: Microsoft lifecycle notification account/subscription/clientState pins across
renew/recreate/recovery; direct importer/onboarding admission, same-account run tokens,
provider status/cursor and native writes. Calendar list-fetch direct cursor and native
cleanup are still separate unchecked response boundaries. Last full fork LOG0672205/75;
no new full fork/full server typecheck/full Claude review/ROB764 Done. Demo/SaleBot
unchanged; no Actions. Skills ai-dev-workflow, behavioral-guardrails, server-schrodinger,
scoped read-only review/research.

LOG-069 publication: code `36f747cf239c0f2462b0574971f6fa578eb1096c` pushed; GitHub ref verified by API. Linear description/comment `8423b44f-d45f-4afe-94bd-bcdc689f024e` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-070 — Microsoft subscription lifecycle snapshot CAS (28.10.2026)

Authenticated Microsoft notification snapshots now reach renew/recreate. Snapshots
copy account, external subscription ID, clientState, status and expiry. Current
ordinary owner admission precedes renew network calls. Existing locked status owner
compares exact nullable values before claim/update/clear; optional legacy callers
remain supported. Create claim pins the fetched snapshot, then failures pin the new
PENDING clientState. Known reset/clear advances expected null expiry/externalId;
recovery cannot adopt a new account or replacement claim. Renew success/error and
delete completion cannot overwrite replacement or newer successful renewal.
Unknown core commit from token refresh is rethrown before failure reset/metrics
in all provider catches and the exception handler; local unknown commit similarly
prevents follow-on operations. No network is held inside a metadata transaction.

659 targeted Jest/7 suites +26 guards=685 PASS;
72 new PostgreSQL/caller cases. Actual orchestration, SQL ownership and Microsoft
handlers execute with explicit network/notification-repository doubles. Coverage:
stale parent/externalId/clientState/status, late renewal/expiry responses, removed/
NOT_FOUND recovery races, new claim vs old create failure, exact null, unknown
admission/clear/OAuth outcomes and unchanged ordinary paths. Initial existing85
and expanded157 webhook cases passed; expanded seven-suite run passed.
Typecheck 291 roots:188/188,0 new/changed-code;
7 migration sources unchanged; LF hashes matched. New helper initially introduced
an unnecessary transitive entity import; moved the single structural snapshot type
to the pure helper, preserving dependency baseline. All guards passed afterward.
Read-only review found expiry CAS and OAuth unknown-commit gaps; both fixed with
regressions, rereview found no further blockers in scope. Reviewer ran no tests.
[Evidence](implementation/log070/README.md).

Limits: local CAS does not fence or serialize external provider operations. No new
full fork run/full server typecheck/whole-project acceptance is claimed. Last full
fork LOG0672205/75. Next: direct import/onboarding admission, DB-precision run token,
provider stage/cursor and native apply. ROB764 remains In Progress, next stages
Backlog; demo/SaleBot unchanged. No Actions. Skills ai-dev-workflow,
behavioral-guardrails, server-schrodinger; scoped read-only review/research.

LOG-070 publication: code `a458b5820c226d3b9fb8048f94a6e3428bac6e0d` pushed; GitHub ref verified by API. Linear description/comment `43009748-9290-4ae0-85a9-3771b463008c` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-071 — direct import admission and exact run status callbacks (28.10.2026)

Both importers now enter only through a locked ordinary/current-account enabled
SCHEDULED→ONGOING update. Fresh channel/account/folders are read in the same owner
transaction; declined/unknown admission stops before legacy cache, aliases and
provider. DB clock produces a six-digit microsecond token, retained separately from
lossy JS Date. Real tokens are frozen; optional callback proofs are copied before
workspace/cache awaits. Existing ordinary/manual status calls without token remain.

Completion, next-batch pending, retry/failure/account-auth status, reset and legacy
recovery compare workspace/channel/account/stage/exact token while holding existing
account→channel locks. Legacy recovery runs after admission and cannot reset another
run. Accepted update rows still control postcommit cache/metrics/broadcast effects;
message ONGOING broadcast retained after known admission. Both core/native unknown
outcomes stop import fallback; message no longer requeues native unknown outcomes.

717 targeted Jest/7 suites +26 guards=743 PASS;
58 new PostgreSQL/caller cases, including concurrent winner, fresh disabled/owned/
stale parent/stage, same-millisecond different-microsecond tokens, completion and
failure after newer run, actual importer error/empty paths, mutable proofs, legacy
reset and unknown admission/native outcomes. Existing fixtures now seed real SQL
SCHEDULED state and account aliases; caller stage substitution is no authorization.
Typecheck 292 roots:188/188,0 new/changed-code;
seven migrations unchanged; source LF hashes verified. Initial typecheck found one
fixture-only union-repository type error; explicit typed repository branches fixed
it and differential recheck passed. One SSH upload was declined by MaxStartups;
retry succeeded, final source hashes and tests verified the uploaded revision.
Scoped review found optional
legacy recovery token copied only after cache await; entry snapshot fixed and paired
regressions added. Reviewer ran no tests. [Evidence](implementation/log071/README.md).

Limits: this is SQL status/run ownership, not a durable Redis batch lease or complete
provider result transaction. Existing failed message run may requeue IDs to its
account cache and emit monitoring even when later status mutation is declined.
Postcommit cache effects are not atomic with next runs. Native Message/Event save,
association deletion, cursor writes and scheduling producers/onboarding remain
separate work. No full server typecheck/full fork/ROB764 Done claim. Last full fork
LOG0672205/75. Next: onboarding/list-fetch scheduling/run proof, then native apply.
Demo/SaleBot unchanged, no Actions. Skills ai-dev-workflow, behavioral-guardrails,
server-schrodinger and scoped read-only review/research.

LOG-071 publication: code `39f57dc923d5d181bff19d60f44bb7ca7dc1a32e` pushed; GitHub ref verified by API. Linear description/comment `3b30360b-e473-4705-a65a-331410adb841` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-072 — recent onboarding and ordinary message list-fetch admission (28.10.2026)

Recent onboarding now claims enabled, ordinary, expected-account, never-synced
LIST_FETCH_PENDING/SCHEDULED under the existing owner. Full list-fetch claims only
SCHEDULED before group/folder/provider work. Fresh entities replace caller snapshots.
Recent batch handoff consumes the reservation once and rotates its exact DB token
while retaining LIST_FETCH_ONGOING. Success, empty IDs and transient errors return
to full list fetch without setting syncedAt; stale watchdog therefore recovers a
crashed recent import as full fetch. This preserves the recent/full-history distinction
without a new queue or persistent recent-import flag. OAuth callers pin the account
and log rejected background work; existing importer owns error classification.

Normal list-fetch reads current run after group/folder actions, passes proof into
cursor/schedule/completion/errors; cursor keeps startedAt until final transition.
Job no longer performs an unowned second error mutation. Known declined callbacks
stop direct import. Unknown core/native outcomes remain visible without fallback.

739 targeted Jest/7 suites +26 guards=765 PASS;
22 new PostgreSQL/caller cases. Typecheck 292 roots:
188/188,0 new/changed-code diagnostics.
Seven migrations unchanged, uploaded LF source hashes verified. Initial tests found
one fixture bootstrap mismatch, corrected to use an actual protected account.
Initial typecheck also caught a changed ordinary importer return contract and four
fixture union-repository errors; retained Promise<void> and explicit typed repositories.
Dependency guard rejected a new onboarding-to-handler edge; removed it and reused
the existing import owner's error path, baseline unchanged. Scoped independent
read-only review found no defect; reviewer ran no tests. [Evidence](implementation/log072/README.md).

Limits: provider/native aggregate save and association cleanup still need run proof
inside their native transaction. Redis publication/requeue/cleanup is account scoped,
not SQL-atomic or same-account-run isolated; stale failure monitoring remains.
Exact-size test supplies an empty provider result to exercise completion; it does not
prove recent/full native deduplication or live provider integration. Full server
check and ROB764 acceptance are not complete. Last full fork LOG067:2205/75.
Next: calendar list-fetch admission/cursor finalization, native apply, final regression.
Demo/SaleBot unchanged; no Actions. Skills: ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped read-only review/research.

LOG-072 publication: code `87c96976095cf040bc75e6deb599bafd8940fee1` pushed; GitHub ref verified by API. Linear description/comment `e17a469c-3439-4a84-9e10-7d788989d81f` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-073 — calendar list-fetch and atomic cursor/status result (28.10.2026)

Calendar list-fetch claims ordinary/current-account/enabled/SCHEDULED through the
existing transaction owner and loads fresh channel/account. Declined admission stops
before legacy cache/provider. Legacy recovery and errors carry the exact DB run proof.
Completion now atomically updates cursor and IMPORT_PENDING or completed/full-fetch
pending status. This avoids clearing the run token before a separately committed
cursor write. Success metrics are emitted only after known accepted completion.
Fetch returns accepted/declined; webhook refuses inline import after a declined fetch.

756 targeted Jest/7 suites +26 guards=782 PASS;
17 new PostgreSQL/caller cases. Typecheck 292 roots:
188/188,0 new/changed-code diagnostics.
Seven migrations unchanged, source LF hashes matched uploaded tests. Tests exercise
concurrent actual fetch, current enabled/parent/ownership/stage, empty/nonempty
finalization, stale response after reparent/new run, legacy recovery, microseconds,
rollback and unknown commit, stale temporary failure and webhook declined result.
Provider/network/cache use explicit doubles. [Evidence](implementation/log073/README.md).

Limits: native association deletion/orphan cleanup and aggregate save still need run
proof inside their own native transaction. Redis publication is account scoped, not
atomic with SQL or isolated per same-account run. This slice does not claim those
side effects are suppressed. No full fork/full server typecheck/ROB764 Done claim;
last full fork LOG067:2205/75. Scoped read-only review, no reviewer tests.
Next: native result apply and cleanup, then fresh regression/acceptance.
Demo/SaleBot unchanged, no Actions. Skills ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped read-only research/review.

LOG-073 publication: code `a01939626bf9e9b72f151973410ea64aed8bf536` pushed; GitHub ref verified by API. Linear description/comment `22092ed5-291d-41a2-858e-18bd28fa2c6b` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-074 — native provider-result apply in the current run (28.10.2026)

Message and calendar aggregates copy run/account/channel before await and validate
scope. Within the existing native transaction/shared ownership fence, account SHARE
and channel UPDATE locks protect fresh parent, enabled flag, exact stage/microsecond
run and complete ordinary ownership check. A declined proof returns before native
reads/writes and postcommit work; import callers stop before completion. Strict
unknown commit propagates without enqueue/rematch.

Calendar pre-read/build/write, including existing participants and other-channel
metadata, now use the same native scope; no nested native transaction. No-run
ordinary and APP targets-only paths retain their contract. Nullable message
participant address/name remain null in native rows; only addressable contacts enter
the contact queue, where missing display name becomes empty string as required.

Full fork 2443 Jest/76 suites +26 guards=2469 PASS; 29 new PostgreSQL cases. Typecheck 294 roots:188/187,0 new/changed-code. Seven migrations unchanged.
Tests cover stale parent/run/stage, disabled/native/derived ownership, aggregate
rollback, real COMMIT lost ACK, same-channel serialization, two-channel calendar
sharing, run UPDATE waiting for native COMMIT, nullable participant identities.
Initial type gate found an existing nullable mismatch in the changed method; fixed
and rechecked. Local/test-source LF hashes match. Scoped independent review found
no remaining issue; reviewer ran no tests. Queue/matcher/provider use explicit doubles.

Limits: provider association/orphan cleanup and Redis publication/requeue do not yet
carry run proof. Contact creation and matching after accepted COMMIT are outside run
protection. No full server typecheck/ROB764 Done/live transport acceptance claim.
Ordinary email cache retains legacy delivery semantics (phase_1_data step 3; spec §15.18); this does not require a new durable email pipeline. Verify delayed callbacks cannot mutate omni.
Next: guarded native cleanup, Redis and postcommit ownership review, then final
stage acceptance inventory. Demo/SaleBot unchanged; no Actions. Skills ai-dev-workflow,
behavioral-guardrails, server-schrodinger; scoped read-only research/review.

[Evidence](implementation/log074/README.md).

LOG-074 publication: code `bf37f6f2de392784215e9770d00486ad3f03c334` pushed; GitHub ref verified by API. Linear description/comment `13f90a3f-2c46-4679-af94-c1d02fa67ca2` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-075 — guarded native cleanup and reference concurrency (28.10.2026)

Provider message cleanup copies expected run before await and checks it inside the
existing strict native transaction. Group-action and no-run legacy callers remain
supported. Calendar fetch/import now use one scoped association+orphan cleanup owner;
legacy orphan wrapper reuses the in-scope implementation. Declined cleanup stops the
caller; unknown outcome propagates without final success/cache publication. Message
cursor now advances only after all cleanup chunks accepted. Prior committed chunks
remain committed; the whole provider page is not one transaction.

Read-only review found races with a concurrent second-channel reference and late
association reassignment. Candidate parent rows are locked before reference reread;
message Threads precede Messages. Child associations are locked after parents and
reread with original channel/external-ID predicates. Changed parent conflicts are
explicit. Fixed table allowlist, validated UUIDs and active lifecycle constrain the
internal lock helper. Legacy multi-page transactions can still encounter PostgreSQL
deadlocks and roll back; no claim of global cross-page ordering or deadlock freedom.

496 targeted Jest/5 suites +26 guards=522 PASS; 41 new PG/caller cases. Typecheck 295 roots:187/187,0 new/changed-code. Seven migrations unchanged.
New cases: stale parent/run/stage/ownership declines, complete cleanup, shared graph,
rollback after association deletion, real COMMIT lost ACK, wrong proof scope, both
orders of concurrent reference INSERT and channel/external-ID reassignment, actual
fetch/import callers stopping on false/unknown and bounded second-chunk refusal.
Initial failures were fixture omissions (workspace accessor/calendar handle) and the
expected ORM translation of injected PostgreSQL errors; corrected before final run.
Local/test-source LF hashes match. Independent source review; reviewer ran no tests.

Scope: ordinary Redis publication/pop/requeue and contact jobs retain legacy behavior.
They are not the new omni durable receipt/outbox. No exactly-once ordinary email or
SQL/Redis atomicity claim. Protected native writes/rematching already have ownership
barriers; delayed boundary acceptance remains to be exercised. No live demo/provider
changes, no Actions. Full server typecheck remains nonclean from prior diagnostics.

Next: exact 20-way T01 and delayed cache/postcommit ownership negatives; §15.10 minimal
metadata-only domain revision operation (initial revision exists, placeholder/edit/
delete native apply does not). Payload/files/retention expand in ROB-770. Preserve
initial receipt replay after legitimate revision; do not mark ROB764 Done until
required writers and fresh final acceptance pass. T04 real transport stays ROB-768.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only
research/review. Full fork last passed LOG074:2443/76; no new full-suite claim here.

[Evidence](implementation/log075/README.md).

LOG-075 publication: code `926f56119608c8ddeacaaaa676613f2ec81e5c35` pushed; GitHub ref verified by API. Linear description/comment `f9d888dd-6a99-445c-b3af-e83cca9f96c9` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-076 — duplicate and delayed ownership acceptance (28.10.2026)

Acceptance-only changes: ingress concurrency increased from 6 to 20; a fresh
history fixture accepts 20 identical events then applies the claimed receipt 20 times.
Exactly one creation, 19 replays, one receipt/message/link/native graph and ten success
audit entries remain. No duplicate generic events or replacement Thread.

Actual message/calendar importer is delayed after admission at cache pop. Real account
bootstrap establishes derived omni ownership; provider label is reset to ordinary to
exercise derived protection. On resume a pass-through spy proves actual native aggregate
was reached; native/core snapshots, raw events, completion/pending/contact/rematch/requeue
remain unchanged. Admission/status/legacy recovery and external providers are test doubles;
this is not an end-to-end scheduler test or proof of SQL/Redis atomicity.

Participant snapshot is captured before Conversation ownership. Actual matcher and target
reconciliation run after ownership; protected participants/targets/messages remain unchanged,
while ordinary email positive control matches and creates its three targets. This is not a
full contact creation job / Person listener pipeline test.

170 targeted Jest/4 suites +26 guards=196 PASS; 4 new PG cases. Typecheck 295 roots:187/187,0 new/changed-code. Seven migrations unchanged.
First importer suite load hit an ESM dependency via injected constructors; narrow constructor
mocks keep real importers/native aggregate/ORM guards. Initial message fixture was filtered
as internal email (same domain); corrected external sender and added aggregate reachability
assertion. Independent source review found no confirmed defect; reviewer ran no tests.

No runtime implementation changes, no live demo/provider changes, no Actions. Previous full
fork LOG074:2443/76, no newer full-suite claim. Baseline server diagnostics remain unresolved.
Next: §15.10 metadata-only domain revisions: placeholder fill/edit/delete, trusted source
ordering, atomic native body/head/revision/receipt/audit, initial receipt replay after edits.
ROB-764 remains In Progress until that required writer and fresh final acceptance pass.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Evidence](implementation/log076/README.md).

LOG-076 publication: code `6e9e03819d21a69b361f36302ea21c230da2f376` pushed; GitHub ref verified by API. Linear description/comment `6ba8d532-cfb2-4082-bca8-72952daba730` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-077 — current revision schema and initial persistence (28.10.2026)

Added eighth fork migration: nullable MessageLink.currentRevisionId without default
or backfill, Revision UNIQUE(workspaceId,messageLinkId,id), and validated nondeferrable
FK Link(workspaceId,id,currentRevisionId) to that exact revision. Existing seven sources,
checksums and historical schema snapshots are unchanged. Prefix-aware verifier selects
the new Link/Revision snapshot only after eighth ledger entry. Down takes table lock and
refuses any nonnull head instead of destroying current-revision evidence.

New initial history/sent composition inserts Link(NULL), Revision, then head in one
strict native transaction. Final logical Link create audit includes currentRevisionId;
success counts stay 10/14/11. Runtime fixture gets only UPDATE(currentRevisionId).
Replay permits legacy NULL only with the exact single validated initial revision; it
does not adopt NULL or rewrite retained audit. The legacy fixture clears a new graph's
head and retains its new audit shape, so it does not independently simulate every
historical audit serialization. Later domain revisions must support current-head proof
independently from old initial evidence before editing is enabled.

Read-only review found history head readback occurred before audit/final receipt writes.
Added another final readback and PG AFTER-audit/AFTER-receipt trigger regressions. Sent
already rereads core/native graph after both boundaries. Reviewer ran no tests.

Full fork 2508/77 before final history readback; final targeted 188/6 +26 guards PASS. Typecheck 298 roots:187/187,0 new/changed-code. Eight migration sources verified; first seven unchanged.
Full-suite source hashes are retained separately: only history writer and its test file
changed afterward for final readback plus two regressions; all six relevant suites rerun
on final source. No claim that the full suite ran on those last two file versions.
New cases: populated prefix7→8/replay/null down-up; wrong Link/workspace FK; protected
revision deletion; rollback refusal; schema/default/type/FK drift; new head/audit;
legacy NULL replay; ambiguous revision rejection; head UPDATE fault/null tampering and
late audit/receipt tampering. Two old corrupt-fixture setups needed explicit NULL head;
cross-tenant fixture removed an absent provider column. All corrected before final gate. Differential typecheck also found an unknown query row access; explicit UUID row validation removed the new diagnostic, and the six suites/typecheck passed again.

Next: §15.10 incoming text revisions (placeholder/fill/edit/delete). Durable applied
disposition is also required: current receipt.resultId remains canonical MessageLink,
while duplicate/stale need immutable selected/observed revision evidence after head moves.
Use a nullable typed applicationResult on receipt, not audit diffs as operational state
or fake DomainEvents. New incoming writer will validate this outcome and current native
head; automation remains suppressed v0. Public API/UI/transport are later tasks.
ROB-764 remains In Progress. No live demo/provider changes, no Actions. Baseline server
diagnostics remain unresolved. Skills: ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped read-only research/review.

[Evidence](implementation/log077/README.md).

LOG-077 publication: code `bb287f024d44a4c694e73059d07cbf22c89c6378` pushed; GitHub ref verified by API. Linear description/comment `e21d1e95-91f8-4a2a-8cb2-9f104f52d3ab` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-078 — durable incoming application result contract (28.10.2026)

Added ninth additive migration: IncomingReceipt.applicationResult JSONB, nullable,
without default/backfill. SQL CHECK permits nonnull only for applied state + nonnull
canonical resultId + object/version1/incoming_text_revision/known disposition. IS TRUE
rejects missing/null gate keys instead of accepting SQL UNKNOWN. JSON null is rejected;
SQL NULL remains compatible with all old writers. Down locks receipt table and refuses
retained outcomes. Prior eight migration sources/checksums/snapshots are unchanged.
The new CHECK snapshot was generated from PostgreSQL deparse of an isolated temporary
table, then verified against the actual migrated receipt table. Version-aware capture
and message verifiers select the new snapshot only at prefix9. Older prefix tests undo
later migrations in reverse order rather than leaving an incompatible ledger suffix.

Closed runtime schema copies/freezes the flat result, validates normalized UUIDs, bounded
Unicode source key and SHA256; created has no observed head, advanced selects a different
revision, stale selects observed head, duplicate may select a previously known revision.
No implicit source-order comparison occurs. SQL does not enforce JSON revision references
or the full runtime shape: upcoming writer/replay must verify same Link/workspace and
candidate/selected/observed evidence. No application-result writer or public API is enabled.

Application result is redacted by existing audit capture. PG test proves state transition
and changed field are retained without provider revision key/content hash disclosure.
269 targeted Jest/10 suites +26 guards=295 PASS; 50 new cases. Typecheck 303 roots:187/187,0 new/changed-code. Nine migration sources verified; first eight unchanged.
Independent source review found no confirmed blocker; reviewer ran no tests. Typecheck found a UUID template-literal assignment only in the new test. It was rewritten without changing runtime code, its 26 unit cases rerun, and the final differential typecheck passed. Broad-suite and final-source hashes are separately retained; only that test file differs. No full-suite
rerun in this slice. Prior LOG077 full2508/77 precedes its final history readback, whose
final188/6 targeted verification is retained there. No new full-server typecheck claim.

Next: common incoming storage core plus qualified revision branch, preserving legacy
history entrypoint IDs and audit. Placeholder/delete-before-create use one canonical
Message; fill/edit/delete update exact ID under same transaction with head/revision/
receipt outcome/audit. Duplicate/stale write receipt-only outcome, no fake event/counters.
Replay checks retained outcome after current authorization and separately verifies current
native head; it does not reclassify old input against today's head. Incomparable/conflict
must quarantine safely after confirmed rollback; unknown COMMIT stays unknown. Automation
remains suppressed v0. ROB-764 In Progress, UI/transport/ACL/AI tasks remain pending.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo/provider changes; no GitHub Actions.

[Evidence](implementation/log078/README.md).

LOG-078 publication: code `2b2b8c4ba2873c3b236398b28b373289bc257348` pushed; GitHub ref verified by API. Linear description/comment `bc8cb039-b991-4ed2-8c8b-53df893f7f51` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-079 — qualified incoming text revisions (28.10.2026)

Common incoming persistence preserves the legacy history entrypoint, deterministic IDs
and audit conventions. A new internal apply/process facade requires current authorization
and a captured trusted revision adapter. Adapter identity/version must match retained
capture; source positions are opaque to the domain (no timestamp/lexical/numeric guess).
A versioned namespaced key binds qualification to logical revision identity. Semantic
content hash covers canonical key, text, tombstone and completeness; immutable author
and display timestamp are retained from the initial Link.

Initial received/placeholder/edit/delete may create one canonical Message, including a
new Conversation. Exact native text update uses the existing scoped ORM and capability;
head/revision/receipt outcome/audit share the strict transaction. Tombstone clears text,
not native deletedAt. Complete-to-placeholder regression and newer resurrection after
tombstone are rejected. Duplicate or older observations persist a receipt-only outcome,
without another Message/Revision/event/counter. Replay returns retained disposition after
current authorization and evidence checks; it never reclassifies against a later head.
Legacy NULL heads are read-only on replay and transition only within a real new revision.

Retained proof verifies scoped chain, source receipt/envelope/capture/hash, known legacy
or new revision namespace, selected/observed references, initial identity/display and
current native content. Retained success audit and event/root/dispatch evidence are checked.
Batched receipt evidence explicitly preserves bigint routeGeneration as text, including
values above JavaScript safe integer. Final readback after audit and receipt CAS validates
immutable receipt fields, cleared lease/error, current head and native graph. New/legacy
initial replay after edits/deletes does not restore old body. v0 roots remain suppressed.
The chain currently checks retained metadata linearly; large-history load/retention tuning
remains a measured integration concern, not a claim of bounded history cost.

Issued source conflicts can move a receipt to quarantine only after confirmed rollback
and successful failure-audit handling; denied authorization and unknown COMMIT/ROLLBACK
are propagated without that mutation. Missing initial configuration uses blocked_config.
The actual native Message search configuration indexes subject, not body; unchanged NULL
subject does not need an extra body reindex job. Current text remains in native Message.
Files/protected historical payload and real adapter semantics are not implemented here.

Full fork 2598 tests/80 suites +26 guards=2624 PASS; 38 new PG cases. Differential typecheck 307 roots:187/187,0 new/changed-code. Nine migration sources unchanged.
38 new PG cases cover initial/edit/delete, placeholder fill existing/new Conversation,
delete-before-create, immutable author/time, stable duplicate/stale replay, 20 concurrent
writers, different ordered edits, confirmed rollback, real lost COMMIT ACK, unconfirmed
rollback, slow-audit lease expiry, late head/outcome/native corruption, retained evidence
and event/root/dispatch corruption, caller snapshot, and large generation precision.
Scoped independent source review found no confirmed blocker; reviewers ran no tests.
Full suite ran on final source after correcting test-only type annotations and removing
a new type import which introduced a forbidden dependency edge. Guard rules/baseline
were not relaxed. Differential typecheck retains 187 baseline diagnostics; no claim that
the entire server is type-clean. All nine committed migrations remain unchanged.

No public API, real transport, production route or automation activation. Synthetic
adapter comparison in tests is not Telegram/MAX ordering qualification. Existing ordinary
email/cache/contact behavior stays within LOG076 boundaries. Acceptance reconciliation found remaining ROB-764 gaps: unbound identity apply and
early explicit identity/target mutation/projection rollback checks. Current proof still
requires an existing bound Person. These are not closed by the new revision tests.
Projection belongs solely to explicit domain link/unlink, not opportunistic ingress
repair. Implement internal scoped writers with current authorization first; public
policy/API remains ROB-766. ROB-764 stays In Progress; whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; read-only scoped review.
No live demo changes and no GitHub Actions.

[Evidence](implementation/log079/README.md).

LOG-079 publication: code `5fecd9bde8cf60e49e192b6771adc9679eb29567` pushed; GitHub ref verified by API. Linear ROB764 and ROB765 descriptions/comment `90888609-cc10-475c-a542-555073425831` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-080 — incoming messages from unbound identities (28.10.2026)

The incoming apply contract now accepts nullable personId on an existing qualified
ExternalIdentity. Authorizer receives the explicit null. Only a non-null personId
requires a live Person lookup. The actual native participant writer and retained
revision-chain proof preserve null, without calling contact matching/creation or
projecting CRM targets. Distinct external identity/peer IDs remain distinct authors.
A dangling non-null Person reference is rejected, not converted into unbound mode.

116 tests/4 suites +26 guards =142 PASS; 15 new PG cases. Differential typecheck 308 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
Fifteen new PostgreSQL tests cover history/live and existing/new Conversation,
placeholder/fill/edit/delete, legacy replay, current authorization including replay,
dangling Person, unknown identity UUID, native writer substitution, distinct unbound
authors, transaction rollback and generic native message/participant write protection.
The first run exposed two incorrect test expectations for replayed:false; tests now
assert the stable identity and created:false while allowing the actual replay flag.
Final source passed all four relevant suites. Full fork was already run in LOG079;
it was not repeated for this small nullable change. Source hashes match the test host.
Scoped independent source review found no confirmed blocker; reviewer ran no tests.

This does not discover/register identities or implement link/rebind/CreatePerson.
The apply proof still requires an existing ExternalIdentity UUID. Future explicit
link/unlink must preserve historical author snapshots and update current native
relations atomically; replay after a future identity mutation is not yet supported.
The existing generic participant helper does not clear a binding via null: explicit
scoped mutation is required, not redelivery. Target projection remains exclusive to
explicit domain link/unlink, never inferred from incoming participants.
ROB-764 stays In Progress. Whole CRM is unfinished. No migration changes, live demo
changes, real messaging or GitHub Actions. Skills: ai-dev-workflow,
behavioral-guardrails, server-schrodinger; read-only scoped review.

[Evidence](implementation/log080/README.md).

LOG-080 publication: code `5083ea8773bd2d799d97aab8be439ab85cfb9b2b` pushed; GitHub ref verified by API. Linear ROB764 description/comment `e16f4663-9c38-4044-b679-e613435aab8e` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-081 — qualified external identity registration (28.10.2026)

Internal registerOmniExternalIdentity accepts qualified peer/source, expectedRevision0,
route generation and an actor-scoped idempotency key. It reuses the strict core transaction
owner and exclusive native ownership fence. Existing workspace policy is locked UPDATE
before receipt/binding/identity; current authorization is mandatory on initial and replay.
New registration creates only unbound identity revision1 and increments policy epoch;
identity, redacted audit and PolicyMutationReceipt commit together. A different key does
not silently overwrite an existing peer/Person. No automatic contact lookup/creation.

Replay returns the original result/operation after current authorization, verifies the
retained identity-create and policy-update success audits, and never redoes mutation/CAS.
Expired result is visible, actor-key payload/action conflict is rejected. Original
registration result is historical; current identity facts are separately passed to the
authorizer. Generation is fenced on initial creation; authorized replay can acknowledge
an older committed registration after a route generation change. Failure/denial audit is
written only after the transaction owner confirms rollback/release by preserving the
callback error. Unknown COMMIT/ROLLBACK does not create a false failed business entry.
The audit catalog now includes omniExternalIdentity (19 resource kinds); peer/source
are redacted. No new schema or migration.

183 tests/11 suites +26 guards =209 PASS; 27 new PG cases. Differential typecheck 310 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
27 new real PostgreSQL cases cover twenty concurrent retries, actor/action key conflicts,
existing bound identity, current denial/revocation, expiration, route precision beyond
Number.MAX_SAFE_INTEGER, workspace isolation/deletion, identity/audit/receipt rollback,
real COMMIT acknowledgement loss, unknown rollback connection discard, caller mutation,
late row corruption, retained audit corruption, and registration followed by actual
native incoming persistence. Read-only review found the missing replay audit proof;
that finding was fixed and covered by three corruption regressions. The first run also
found an incorrect test event-spy reference; the typecheck found an overly narrow UUID
variable type. Both were fixed before the final 183-test run and differential typecheck.
No new diagnostics; the 187 existing baseline diagnostics remain. Previous full fork
run was LOG079; this bounded change uses relevant suites. Source hashes match the host.

The runtime function is internal only. Real adapter qualification/discovery scheduling
and public endpoints are not wired. Existing ingress still receives an explicitly
registered identity UUID. Link/unlink/rebind/CreatePerson and target writers remain
next; future identity mutation must preserve birth author and support authorized old
message replay. ROB-764 remains In Progress and the whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, real messaging, route activation or GitHub Actions changes.

[Evidence](implementation/log081/README.md).

LOG-081 publication: code `864b4da95ddccab2a5929a3be3ca0318df0e7498` pushed; GitHub ref verified by API. Linear ROB764 and ROB765 descriptions/comment `4f246304-5557-4814-9cf7-36371031e367` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-082 — explicit identity Person binding (28.10.2026)

Internal setOmniIdentityPerson implements link/rebind/unlink with nullable Person,
expected identity revision and actor-scoped idempotency key. Its existing native owner
runs strict transaction semantics with exclusive native ownership and policy UPDATE
before binding/conversation/identity locks. Current authorization is mandatory on
initial and replay. Workspace-specific Person metadata is resolved by the existing
ORM manager; the leaf receives only a narrow descriptor and native mutation ports.

Only native FROM participants belonging to the exact immutable externalIdentityId are
updated. Other external authors, even unbound authors in the same thread, remain
separate. Old immutable author snapshots, provider identity and message text are not
rewritten. Retained audited identity transitions explain the difference between birth
Person and current relation; missing/forged transitions fail closed. Initial/history
replay and subsequent edit/delete use current native Person while retaining birth
provenance. This is not automatic contact guessing or merging.

When Person changes, old active canonical Person edges in affected conversations become
inactive with revision+1; their verified exact manual native projections are deleted.
There is no automatic new Person/Company/Opportunity target. Native participant changes,
canonical target invalidation, projection deletion, identity CAS, policy epoch, redacted
audit and PolicyMutationReceipt commit together. Post-write readback verifies state.
A repeated key returns its original result after current authorization and exact
identity transition / corresponding policy epoch audit verification, including after
later identity changes. Unknown COMMIT outcome does not append a false failed audit.
The audit catalog now has21 resource kinds, including canonical and native targets.
No schema or migration change.

2661 tests/83 suites +26 guards =2687 PASS;21 new PG cases. Differential typecheck 313 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
21 new PostgreSQL cases cover rebind/unlink/relink and old replay, independent authors,
twenty identical concurrent commands, conflicting concurrent CAS, current denial and
revocation, missing/deleted Person, foreign workspace, forged/missing transition proof,
corrupted result epoch, rollback at participant/projection/audit/receipt writes, real
COMMIT acknowledgement loss, and advanced edit/delete after rebind/unlink. Ordinary
native/event regressions are included in the full fork run. New paths emit no generic
matching events. Local and tested source LF hashes match.

Read-only review found advanced revisions still comparing the historical Person and
an incomplete retained result epoch proof. Both findings were fixed and covered by
regressions. The first targeted runs additionally exposed a UUID/text audit join and
several test expectation/type issues; all were corrected before the final full run.
The Enterprise dependency guard found broad imports, which were replaced with narrow
ports and metadata resolution in the existing owner. Guard baseline was not changed.
Typecheck is differential:187 pre-existing diagnostics remain; it is not a claim of a
clean full server build. No large-history performance claim: transition verification
currently reads retained identity audit history.

The writer is internal. Full own ACL/public API, CreatePerson/autoCreatePerson,
explicit new target creation, generic merge/destroy lifecycle and real transport
wiring are still pending respective acceptance boundaries. ROB-764 remains In Progress.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, real messaging, route activation or GitHub Actions changes.

[Evidence](implementation/log082/README.md).

LOG-082 publication: code `dc58792e0b0c645106c239c2c5924a1e9b7dcb39` pushed; GitHub ref verified by API. Linear ROB764 and ROB765 descriptions/comment `d1b7b5f5-be11-4af0-9d3a-f3ede47fbb75` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-083 — explicit conversation CRM targets (28.10.2026)

Internal setOmniConversationTarget implements natural-key link/unlink with
expectedTargetRevision and desired active state. Current authorization is mandatory
on both sides, including replay. The existing owner resolves workspace metadata and
runs one strict native transaction with exclusive ownership fence and policy UPDATE.
Unknown/system/inactive/foreign metadata is rejected. Actual standard/custom table
naming is reused; custom objects are not guessed from a caller-provided SQL name.

Person/Company/Opportunity use exact manual MessageThreadTarget projections; Task and
custom objects use only canonical core edges. Person requires a currently verified
identity observed in this conversation, including audited birth/current provenance.
The writer never invokes automatic matching or adopts an unrelated native projection.
Unlink retains the canonical row/revision and deletes only its verified exact native
projection. Existing parent hard-delete protection also covers retained inactive edges.

Matching expected revision advances the edge; actual=expected+1 and same desired state
is an authorized read-only replay. Older requests after intervening unlink/relink
conflict. A same-state renewal increments revision/epoch while retaining its projection.
Core edge, projection, policy epoch and audit commit atomically. Strict unknown COMMIT
handling allows audited replay without false failure audit. Post-write state is reread.

Retained proof reconstructs the entire edge from create and contiguous update deltas,
checks full current state and immutable natural key, verifies each policy transition,
and checks exact native projection create/delete audit whenever projectionId changes.
A revision-only latest diff is insufficient by itself. This covers independent review
findings for unchanged-field corruption and missing projection audit. Repeated scoped
read-only review found no further confirmed blocker; reviewer ran no tests.

194 tests/5 suites +26 guards =220 PASS;32 new PG cases. Differential typecheck 316 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
32 new PostgreSQL cases cover all five object classes, actual custom table prefix,
current denial/replay, unknown/system/foreign metadata, missing/deleted records,
unverified Person, renewal and stale replay, twenty repeats, conflicting CAS,
projection collision/missing/wrong flags/FK, missing/forged retained proof, four write
failure stages, late corruption during audit flush, real COMMIT acknowledgement loss,
both link-versus-identity-rebind orders and generic deletion of a retained Company.
The five-suite run includes identity/history apply, native mutation guard and parent
lifecycle. No generic matching events are emitted by new projection writes.

The first test run found only a custom fixture grant missing UPDATE needed by SELECT
FOR SHARE. The strengthened proof initially omitted null FK fields present in create/
delete audit; that mismatch and a test error-string expectation were corrected. The
first dependency scan found a broad metadata utility import. The existing ORM manager
now composes the same table-name helper with the narrow standard application constant;
no Enterprise baseline relaxation. Differential typecheck retains187 baseline diagnostics,
with no new/changed-code diagnostics. Source LF hashes match the tested host.

No new schema or migration; all nine migration files are unchanged. Last full fork run
was LOG082 (2661/83); this slice passed the five relevant suites. The catalog remains21
resource kinds. No large-history performance claim: retained proofs currently scan the
edge's audit history. Current authorizers remain internal/test-injected; full runtime
ACL/public API, CreatePerson/autoCreatePerson, generic merge/destroy and actual external
connectors are pending. ROB-764 remains In Progress; the whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, real messaging, route activation or GitHub Actions changes.

[Evidence](implementation/log083/README.md).

LOG-083 publication: code `8f5df15c6f09f060ed8a76631a145f1dfbceb1db` pushed; GitHub ref verified by API. Linear ROB764 and ROB765 descriptions/comment `d4267676-58be-4be8-92a1-c012203b0644` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-084 — explicit native Person creation (28.10.2026)

Internal createPersonForOmniIdentity reuses the strict identity mutation owner and
same-transaction primitive. A discriminated internal request keeps existing set/link/
unlink behavior and its payload/action hash unchanged. Creation has a distinct action,
closed structured name allowlist, expected identity revision and actor-scoped key.
Current authorization, retained receipt check, CAS and unbound identity check happen
before native insertion. Person ID is server-generated inside the transaction.

Native Person insert uses the issued workspace scope with explicit event suppression;
the messaging wrapper alone does not suppress Person events. Existing native field
conversion/validation is reused. No contact job, automatic email/phone/handle matching,
or new target projection. Prior native FROM participants are bound while birth author
snapshots remain unchanged. Person/participants/identity/epoch/audit/receipt commit
atomically, with initial and final Person-name readback. Catalog adds omniPerson (22
resource kinds); personal name appears only in redacted changedFields, not audit values.

Replay after current authorization checks original identity transition/policy proof
and native Person creation audit, returns the original Person ID and never creates or
rebinds again. It does not overwrite subsequent legitimate Person edits. Already bound
identity with a new command fails. Native transaction unknown outcomes do not become
false failed audits. Ordinary upstream record-stock acquisition remains after-commit;
callback failure is logged and does not turn committed creation into failure. This is
not a new exactly-once stock/quota mechanism.

129 tests/5 suites +26 guards =155 PASS;22 new PG cases. Differential typecheck 317 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
22 new PostgreSQL cases cover first-message and existing-history creation, redaction,
twenty retries, competing keys, already-bound identity, payload/action conflict, current
permission/revocation, all six write-stage failures, real COMMIT acknowledgement loss,
missing creation audit, nested caller mutation, forbidden fields/empty name/foreign
workspace, late name corruption, unchanged later Person edits and stock callback failure.
The five-suite run includes old identity/target/history and native audit transaction
regressions. A first differential typecheck found four errors in union callback rest
argument typing; explicit tuple parameter types fixed them before the final test/type run.
No new/changed-code diagnostics;187 baseline diagnostics remain. Source LF hashes match.

Scoped read-only source review found no confirmed blocker. A separate normative check
confirmed that audit does NOT replace the required visible/governed Person-created
notification from sending-ui. That integration is explicitly open in ROB-769 producer
inventory and phase5, with activation prohibited until coverage is implemented. This
slice provides atomic internal storage; it does not claim event/automation readiness.
Public ACL/API remains ROB-766. Live autoCreatePerson is still disabled/unimplemented;
it is next within phase1, and history/restore must never auto-create.

No schema/migration change. Last full fork regression LOG082:2661/83; this slice uses
five relevant suites. ROB-764 remains In Progress and the whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, actual external messaging, route activation or GitHub Actions changes.

[Evidence](implementation/log084/README.md).

LOG-084 publication: code `ee4550f9df3bad374a95b3010c4a0fe3a860c9ea` pushed; GitHub ref verified by API. Linear ROB764, ROB765 and ROB769 descriptions/comment `423dae07-469f-4f27-94da-629c833f620e` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-085 — opt-in live automatic Person creation (28.10.2026)

The existing binding.defaults.update accepts optional autoCreatePersonEnabled.
Omission preserves the current value and old payload hashes. Explicit enabling exposes
a distinct current administrator/create authorization fact, including retained replay.
CAS/revision/policy epoch, audit, configuration event and wakeup share one commit.
Default remains disabled. No schema/migration change or public endpoint is added.

Qualified incoming adapter apply takes policy UPDATE from the start. It may create
Person only for a new processing trusted-live incoming complete message.received,
verified unbound identity and enabled current binding; source result must be created,
advanced or duplicate. Stale events, edits, deletes, placeholders, import and restore
never auto-create. A distinct mandatory current create authorizer receives both the
identity/old conversations and the current incoming conversation/queue facts. General
ingress permission alone does not grant creation. Existing full runtime ACL is pending.

The same-scope LOG084 create primitive is reused, with one shared native repository
port for explicit and automatic creation. Person, identity/previous FROM participants,
policy epoch, child receipt/audit, message/revision and incoming receipt are atomic.
Child operation/key derive from incoming receipt ID, with a server-owned system actor;
its audit does not contaminate the outer message replay proof. No nested transaction,
contact matcher, guessed email/phone or automatic conversation target. The initial
label is sourceDisplayName normalized for controls, trim and 256 UTF-16 units; absent
label uses the verified providerPeerId as an identifier, never an invented name.
lastName remains empty. Name is redacted in audit.

Import-to-live duplicate creates one Person and binds prior participants without
rewriting immutable birth snapshots. Applied receipt replay only verifies retained
child proof and never creates again, including after disable or manual unlink. Later
legitimate Person-name edits remain valid. Missing child receipt/audit fails closed.
Native input and birth snapshot use the updated identity. Fresh child Person/identity
are reread after the final outer receipt write; retained replay does not restore names.

170 tests/5 suites +26 guards =196 PASS;34 new PG cases. Differential typecheck 318 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
34 new cases:6 configuration and28 automatic creation cases. Real PostgreSQL tests
cover first Conversation/Thread, imported duplicate, placeholder completion, excluded
origins/kinds/stale input, current and missing create permission, disabled/omitted
settings, CAS/race/key conflicts, two concurrent messages +20 retries, five failure
stages, real COMMIT ACK loss, receipt/audit proof removal, manual unlink with flag both
on/off, two late corruption triggers and lease expiry before final receipt CAS.
The focused run also covers existing explicit creation and history/revision pipelines.
The first test setup incorrectly passed bindingId to a closed configuration principal
and counted pre-existing stock callbacks; both fixture mistakes were corrected.
The typecheck caught five errors from losing the generic issued-scope type during port
extraction; using the existing manager callback type fixes them without adding an
Enterprise dependency. Guard baseline was not changed. Type diagnostics remain187.

Read-only source review found the late Person/identity postcondition gap; final fresh
readback plus two trigger regression cases fixes it. Re-review found no further blocker.
Review also identified outstanding phase1 acceptance work: permitted parent destroy
adapter under spec15.21 and a current actual startup/restart smoke for nine migrations.
Fresh full Jest alone would not establish either. ROB-764 remains In Progress.
Governed Person-created notification/target intents remain ROB-769; audit is not a
substitute for visible events. Producer inventory now names this automatic caller.

No live demo change, external messages, route activation or GitHub Actions.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Evidence](implementation/log085/README.md).

LOG-085 publication: code `8d6a2671d20984e905fdbf145108d5a6c3a4a116` pushed; GitHub ref verified by API. Linear ROB764, ROB765 and ROB769 descriptions/comment `1117dcf4-b40e-422e-83a1-8a077b9de8d1` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-086 — exact-record detached parent deletion boundary (28.10.2026)

An issued exclusive transaction scope can temporarily grant hard deletion to one
registered native repository for one workspace/object metadata ID/record ID. Scope,
repository and transaction identity are checked using existing internal issuance.
Caller-created copies and permission bypass flags confer no authority. The grant
is revoked on callback completion or failure and cannot survive transaction release.

Before parent row selection, policy UPDATE is acquired. A closed, immutable manifest
names every retained target tombstone and revision. Each edge must be inactive with
no projection and have complete retained transition/policy audit proof. Person must
have no current ExternalIdentity binding or owned MessageParticipant reference;
Person/Company must have no owned MessageThreadTarget reference, including deleted
native rows. History/tombstones are retained, not erased to evade ownership guards.

WorkspaceRepository still denies generic protected hard delete. The exemption
requires exactly one locked row and the exact workspace/metadata/record manifest.
Detachment is rechecked through the actual native executor after selection. An
unprotected companion row in a batch is not authorized by this grant. Ordinary
unprotected behavior is unchanged; existing FK behavior is not replaced here.

231 tests/6 suites (105/4 +126/2) +26 guards =257 PASS;28 new PG cases. Differential typecheck 320 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
28 new PostgreSQL cases cover Person/Company preservation; ordinary refusal;
active/missing/extra/stale targets and missing audit; retained identity and unexplained
native references, including soft-deleted rows; copied/shared/foreign/previous scopes
and repositories; wrong metadata/mixed batches; callback failure/normal revocation;
caller mutation and late reference creation. Six concurrent races exercise target
reactivation and identity binding in both transaction orders. Native guards and
identity/target/lifecycle regression also pass. Typecheck initially caught unsupported
toSorted and an ambiguous helper promise type; copied-array sort and an async helper
fix the errors without widening TypeScript settings. No dependency baseline change.

Read-only review found no confirmed blocker; suggested race coverage was added.
This is an internal prerequisite, NOT the completed domain destroy command. The
positive fixture deletes through the temporary grant but does not establish a
production destroy audit, idempotent receipt, current ACL or governed delete event.
The next writer must atomically unbind identities, deactivate targets, invoke this
boundary and flush its own destroy audit/receipt. Current startup/restart with nine
migrations and final full regression remain required. ROB-764 stays In Progress.

No demo mutation, external messages, route activation or GitHub Actions.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Evidence](implementation/log086/README.md).

LOG-086 publication: code `8e0c839c13ded9c941dd96ac36e2e015062532c3` pushed; GitHub ref verified by API. ROB764 description/comment `d03bbcb6-264f-467c-b82a-ccddeace3cb8` independently read back; all11 project states match. ROB-764 remains In Progress.

## LOG-087 — atomic administrative parent destroy (28.10.2026)

Internal destroyOmniCrmParent reuses the current aggregate transaction owner and
LOG082/083 leaf writers plus LOG086 exact-record deletion capability. The closed
request has metadata/record ID, full native-row SHA256 fingerprint, exact identity
and target revision manifests, and actor-key idempotency. No public endpoint or
permission bypass option is introduced. A mandatory CURRENT administrative destroy
authorizer receives all retained identity/target/conversation scopes and current
conversation scopes; history is never treated as an enduring grant.

One strict exclusive transaction locks policy, bindings, conversations, identities
and then the parent. It unbinds all current identities and deactivates remaining
targets without erasing retained target transitions, Message/Thread or author history.
Child operation IDs are distinct and stable within the root operation. Actual
pg_constraint/attribute metadata is inspected for every inbound FK, including custom
and composite keys and soft-deleted child rows. Any remaining reference causes a
full rollback. This bounded writer does not silently accept unaudited SET NULL or
cascade effects; full general native lifecycle work remains ROB765.

The native parent delete, root policy epoch, root audit and receipt are committed
together. A parent snapshot fingerprint is rechecked before deletion. Final native
history fingerprint, parent absence, retained detach proof, receipt, policy and root
audit are checked after the final receipt write. Only expected participant personId
and updatedAt changes are allowed; timestamp is cast through the actual native row
type and all other row fields remain compared. Generic raw events are suppressed.

The existing audit catalog adds omniCompany (23 kinds total) and a closed
currentWorkspaceAdministration deletedParent descriptor with metadata/name. Parent
destroy cannot substitute one arbitrary binding scope. Retained multi-binding
manifest is bound to root audit by destroyScopeHash; content/names remain redacted.
A retained actor-key receipt is read before looking for a live parent. Replay requires
current authorization and retained audit/policy integrity; it never deletes a new row
that reused the old ID. Missing receipt cannot establish previous success. Real COMMIT
acknowledgement loss remains unknown until retry; it does not emit a false failed audit.

209 tests/8 suites +26 guards =235 PASS;37 new PG cases. Differential typecheck 323 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
37 new PostgreSQL cases include multi-binding unlink, current versus retained queue,
caller snapshot, stale manifests, wrong metadata, no target, absent parent,20 retries,
real COMMIT ACK loss, revoke, altered receipt/scope/missing audit, five injected failure
stages, custom and composite/soft-deleted FK refusal, late body/author/participant
corruption and five invalid audit descriptor variants. The corruption trigger has
owner privileges ONLY in the test fixture to exercise the final history guard; normal
runtime correctly cannot change immutable author fields. Existing audit, target,
identity/creation/automatic-creation and lifecycle suites also pass.

Investigation fixes: pg_catalog name arrays needed explicit text casts for the driver;
expected participant timestamp initially omitted the ORM updatedAt write. Read-only
review confirmed the timestamp issue and lock-order discrepancy; both were corrected.
Fault-injection assertions inspect the preserved PostgreSQL cause through the ORM
error wrappers. Re-review found no remaining confirmed blocker; composite FK tests
were added. No dependency baseline or migration source was relaxed.

ROB764 is still In Progress: current actual server/worker startup/restart on empty and
previously upgraded DBs and final full fork regression are pending. Full native audit
is ROB765, public authorization/UI integration ROB766/768, and governed delete/visible
events ROB769. This does not enable normal UI hard-delete or background trash to use
the administrative domain command automatically. No production demo or transport
was changed. GitHub Actions was not used.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Evidence](implementation/log087/README.md).

LOG-087 publication: code `a2b8da3c321b827705a15d5a1cd9aa669453e3a4` pushed; GitHub ref verified by API. Linear ROB764, ROB765 and ROB769 descriptions/comment `a2bbb1a9-97e6-4967-9a2d-944f27132be7` independently read back; all11 project states match. ROB-764 remains In Progress.


## LOG-088 — проверка настоящего запуска: исправление package exports

LOG-088 / ROB-764 In Progress: реальный запуск нового образа выявил два импорта
через закрытые package subpaths. Исправлены экспорты констант через узкий application-runtime.
69 PostgreSQL tests/2 suites и26 guard/checksum tests проходят; typecheck189/189,0 новых.
Полная пересборка, startup/restart и негативные runtime gates пока проверяются.
Последний полный fork regression — LOG082:2661 tests/83 suites; LOG087:235 targeted+guard PASS.
Демо прежнее; GitHub Actions не используется.

 IN PROGRESS. ROB-764 remains In Progress; current runtime acceptance is not passed.

A complete git archive of 6dff1d0875e6f6b68a1185e68c0200c509626c9f built through
its official Dockerfile twenty-server target. Actual migration of an isolated empty
PostgreSQL database failed before the native command started: ERR_PACKAGE_PATH_NOT_EXPORTED
for twenty-shared/application/constants/TwentyStandardApplicationUniversalIdentifier.
A second deep metadata constant import had the same package-exports defect. Jest source
resolution and SWC compilation did not exercise Node's packaged export boundary.

The fix reexports both original constants through the existing narrow application-runtime
entry point, with generator-discoverable source files and the corresponding barrel.
No constant duplication, new dependency, migration change or Enterprise exception.
The broad metadata barrel was rejected by the dependency guard and is not used.

Validation of the fix: 69 PostgreSQL tests in 2 suites, 20 dependency guard unit tests,
6 migration checksum unit tests, nine unchanged migration checksums, dependency baseline
pass. Differential typecheck maps application-runtime to each snapshot's source barrel
because the old test image cannot contain the newly exported symbols. Baseline and current
both have 189 existing diagnostics, with no new or changed-code diagnostics; this is not
a clean full-server typecheck. Uploaded source hashes match the local LF source.


[Evidence](implementation/log088/README.md).

LOG-088 fix publication: `8855d9e4ecc07e2502a63de1d3971847d883ff36` pushed and GitHub API verified. Linear ROB764 description and comment `244404eb-ee19-46cb-8299-fc3d6ae8e6ae` independently read back; all11 states match. Actual rebuilt runtime checks are pending. Scoped read-only package/export review found no remaining blocker.


## LOG-088 — итоговая приёмка ROB-764 и переход к ROB-765

LOG-088: собственный объём ROB-764 проверен и завершён. Полный fork regression:
2814 tests/88 suites +33 guard/checksum/Linux startup tests =2847 PASS.
Образ из commit8855d9e4 проходит миграции пустой/заполненной старой базы, replay,
реальный startup/restart server+worker и отрицательные schema/ledger/privilege gates.
CRM-записи и upstream ledger сохранены по контрольным суммам. Новых ошибок типов нет.
Следующий этап ROB-765 — аудит обычных CRM/ORM изменений; он начат.
Публичные права, внешние коннекторы, чаты и автоматизация ещё не готовы.
Демо прежнее; GitHub Actions не используется.

Фактический runtime: server health200 и27 worker queues до/после restart в обеих БД, все exit0/no OOM. Неполный ledger, schema drift и owner role отказаны до запуска; восстановленная схема проходит gate. Full committed image ec91306f8b6f3648f6bfdf93cf9acf4e5a2d6091b309d0612fdd48450b187ae4; архив и4 source hashes сверены. Full regression886.901s/exit0. Тесты не выполнялись через GitHub Actions.

Read-only acceptance review новых собственных gaps не нашёл; исправлены устаревшие pending формулировки. ROB765 reuse research выявило отсутствие гарантированной транзакции у обычного Company update и зависимость snapshots от event flag; следующий patch исправляет это для первого audited native среза. Existing omni audit protocol сохраняется.

LOG-088 final publication: acceptance commit `043e5e0fd02cf41947b0718854d0dd2619b685fe` pushed/API verified. ROB764 Done and ROB765 In Progress descriptions, completion comment `48fb3320-1879-4ec1-aa48-db15de601041` and all11 project states independently read back. New phase work continues.


## LOG-089 — первый native CRM audit owner, ROB765

Внутренний opt-in Company scalar update/updateMany: server-derived actor, strict
transaction/executor, locked precise before/after, first/last aggregation и flush
до COMMIT независимо от events. Новые crmRecord/objectMetadataId и apiKey principal;
все значения native diff редактируются, field IDs сохраняются. Unsupported writes
poison owner даже при caught error. Ревью выявило NUMERIC rounding и опасный повтор
operationId; исправлены DB-side JSON-text и operation lock/reuse refusal до callback.

570 tests/22 suites PASS +26 guard/checksum tests,9 migration checksums неизменны.
28 новых PG cases. Typecheck323/326 roots:189/189 baseline diagnostics,0 новых и0
в изменённых файлах.8 uploaded/local LF hashes совпадают. Первичные test-fixture
ошибки (metadata field name, nullable custom NUMERIC, error cause chain) и12 test-only
TypeScript diagnostics исправлены; финальные результаты сохранены.

[Evidence](implementation/log089/README.md). ROB765 In Progress; это opt-in основа,
не public native coverage. Далее native CRUD/merge/files, operation lookup index,
actual writer wiring, metadata/session owners и negative audit. Демо не менялось,
GitHub Actions и внешние отправки не использовались.
