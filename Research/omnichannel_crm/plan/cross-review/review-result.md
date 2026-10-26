# R16 — независимый проход всего плана, 27.10.2026

R16 / LOG-018: независимый Claude A проверил 39 технических документов и исходники; needs_revision (3 Medium/7 Low). Исправления внесены в нормативные владельцы, API и этапы. B и адресные проверки закрыли 30 проявлений раунда и все 66 известных причин. Общий fresh full pass исправленной редакции не заявлен. Два раунда с большинством замечаний от правок: широкий цикл той же формы остановлен; следующий подход требует решения владельца. ROB-772 In Progress, ROB-764 Todo; новый omnichannel runtime не начат.

## Проверка и изменения

[Fresh A](claude-r16-full-a.md) выполнен новой сессией Claude Code `dd6c0324-4c06-4923-96d7-2867eca24760`, reported model `claude-opus-5-5`. Пакет: 39 технических документов и закреплённые исходники; прошлые findings/реестр/verdicts исключены до запуска. [Авторская проверка](codex-r16-review.md) сохранена до результата A, но автор знаком с историей и не называется вторым слепым reviewer. A: needs_revision, 3 Medium и 7 Low; Critical/High не найдены, перестройка архитектуры не потребовалась.

Главные исправления внесены у нормативных владельцев:

- AutomationPolicy/Version: immutable settings, захваченная версия у roots/references/commands, короткая публикация head. Точный version fence запрещает старые non-human действия сразу после commit; cleanup ограниченными пакетами, без массовой блокировки всех диалогов и без отмены pending human replies.
- Общий root ledger эффектов/hops: atomic all-root charge, повтор не расходует квоту снова. Все начальные события одного admission разделяют initial snapshot; burst не смешивает версии политики.
- PolicyMutationReceipt и revisions: административные CAS/replay/lost ACK; секрет webhook при повторе не выдаётся. Минимальная policy schema с disabled v0 нужна ROB-764, full publication/automation остаётся ROB-769.
- Dynamic WorkspaceMember не объявляется core FK target. Отдельны read cursor, participation, assignment и historical author mapping; у каждого определены lifecycle/права.
- Уточнены cancel authority, недостающие API, служебный sequence, явный deny CLASSIFY, SSE recheck и principal автоматического assist.
- Canonical lock order, schema/индексы, owner index и производные этапы/таблицы синхронизированы.

[B](claude-r16-reconciliation.md) подтвердил исходные исправления и выявил регрессии. [Targeted](claude-r16-finalcheck.md), [C1–C4](claude-r16-confirmation.md), [C5](claude-r16-lastcheck.md) подтверждают закрытие последних изменений по фактическому тексту. Всего 30 проявлений в раунде (включая self/editorial и исправления исправлений), 21 порождено правками; все 30 closed_in_plan. Все 66 известных root IDs closed_in_plan; новых root IDs нет. Mapping F2 → M-13 и F8 → H-3 исправлен по reviewer. [Реестр](registry.md) сохраняет происхождение каждого проявления и промежуточные статусы.

## Доказательства и границы

[Механические проверки](verification-r16.json): локальные ссылки, JSON, уникальные root IDs, scope/diff. [Owner anchors](owner-links-r16.json). Таблица схемы проверена отдельно: 51 строка сущностей, три колонки, без разрывов; obsolete Conversation.revision/single initial plan references из текущих технических документов убраны.

[Полный source packet](packet-source-integrity-r16.json): 31 441 tracked source/config/test/build файлов совпали с pinned `729f6236126eddaa68d176fb766bc349b19de11d`, отсутствующих/подменённых/посторонних файлов нет. [52 выбранных source hashes](source-baseline-r16.json) проверены автором. Это identity check, не чтение всех тел файлов. Что именно прочитал reviewer и что недоступно — перечислено в raw A/B.

[Audit A](cli-tool-audit-r16-a.json) и [всей сессии](cli-tool-audit-r16-final.json): Read/Grep/Glob, без выходов за packet и без mutation tools. Хэши вычислял автор, не read-only Claude. Пакет и его индекс обновлялись после завершения A для B/targeted, исходный A snapshot сохранён.

Абстрактная модель: 1712 случаев, 0 failures, 23 negative controls пойманы. Она не проверяет новые version-head/root ledger/SQL cleanup контракты и P14; это явно отмечено. Runtime T01–T33, реальные SQL/коннекторы/UI и gates G01–G20 с подгейтами не выполнены. Внешние userbot repos, live state и production лицензии остаются предметом квалификации соответствующих этапов. Runtime/БД/деплой/клиентские сообщения в R16 не менялись.

## Почему не закрыт ROB-772 и что дальше

Запрошенный независимый проход выполнен; все известные замечания исправлены и адресно закрыты. Общий fresh full pass исправленной редакции не заявлен: A нашёл Medium, затем контракты менялись. ROB-772 остаётся In Progress, blocks ROB-764 (Todo); ROB-765–771 Backlog, ROB-762/763 сохраняют исторические Done.

Достигнут количественный stop cross-review-convergence: R15 — 16/27, R16 — 21/30 проявлений порождены исправлениями. Правило: «если ... в двух раундах подряд больше половины экземпляров раунда ... имеют признак “порождено исправлением” любого раунда — не запускай третий раунд той же формы». Финальный targeted reviewer также считает остановку обоснованной. Это остановка широкого цикла, не снятие finding и не owner acceptance риска.

Рекомендуемый следующий подход: зафиксировать исправленный план как исходную спецификацию, по решению владельца изменить критерий завершения ROB-772 и начать рабочую реализацию ROB-764 с PostgreSQL integration/fault-injection tests по его контрактам. Подтверждать поведение кодом и тестами этапа; затем проверять конкретный diff и доказательства. Это рекомендация, не разрешение начать код/деплой и не сделанный шаг. [Лист остаточного риска и решение](residual-r16.md). [Предыдущий результат R15](review-result-r15.md) сохранён.
