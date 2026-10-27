# LOG-029 — штатное сохранение Message и связи с Person

ROB-764 остаётся In Progress. Реализован узкий optional contract canonical Thread
в штатном MessagingMessageService: exact mapping чатов, active strict scope,
проверка workspace, snapshot входа до await, отсутствие объединения разных чатов.
Существующий пустой Thread переиспользуется, новый создаётся с заранее выбранным
ID. Противоречивые header/channel references и текущие tombstones отклоняются.
Удалённая старая история не блокирует другое новое сообщение. Прежний путь без
options сохранён, ownership/authorization остаются обязанностью domain writer.

В audit catalog добавлен omniMessage: binding/conversation обязательны, текст,
тема, header и даты хешируются; открыто сохраняются только Thread и isDraft.
Уточнён persistence contract в implementation-spec §15.10.

## Проверки

[Полный результат](verification.json), [Jest](tests.txt),
[финальный native прогон](native-final.txt), [TypeScript](typecheck-differential.json),
[dependency guard](dependency-guard.json), [migration checksums](migration-checksums.json).

261 PostgreSQL + 93 unit + 20 dependency guard + 5 checksum = 379 тестов прошли.
После исправления типов повторены все 19 native сценариев. Реальные metadata
builders, schema managers, pg transaction, native repositories и services
создают Message/Thread/association/participant/Person и проверяют relation read.
Проверены общий commit с аудитом, невидимость до commit, rollback после audit,
ошибка audit/FK, replay, canonical mapping, tombstones и detachment входной map.
Положительный контроль подтверждает обычные события после COMMIT; omni wrapper
подавляет их. Source LF-SHA256 локально/на тестовом хосте совпали: [снимок](source-snapshot.json).

При первом запуске fixture подтягивала ESM AI через неиспользуемые DI/entity
ветки. Изолированы только классы WorkspaceOrmManager, MatchParticipantService
и IndexMetadataEntity; вычисление DDL/индексов и persistence не подменяются.
Context loading заменён fixture, record stock и event sink — test doubles.
Используются пять настоящих стандартных таблиц и FK внутри этой группы;
внешние связи с остальной CRM/core и Person search-vector expression не входят
в эту проверку. Это не полный AppModule/native lifecycle тест.

TypeScript сравнен с LOG-028 в одинаковой среде и с одинаковыми дополнительными
native dependency roots: 101 текущий root, 0 новых/0 ошибок в изменённых файлах.
141 исходная диагностика расширенного импортируемого графа остаётся; увеличение
от 122 в LOG-028 связано с охватом native generators/services, не новой регрессией.
Различия формулировок при совпадающих source/line/code сохранены отдельно.
Полный server typecheck и новая production-сборка не заявляются.

Адресное независимое ревью не нашло blocker/major. Замечание о deleted history
уточнено в spec. Четыре миграции неизменны; guard не ослаблялся. Claude Code и
новый полный архитектурный круг не запускались. GitHub Actions не используется.

## Продолжение

Следующий шаг: immutable trusted capture context в receipt, затем domain
Conversation/Identity/MessageLink/revision/DomainEvent writers, foreign ownership
и background exclusions. Полный apply обязан проверять lease последним под
доменными locks и сохранять Message+link+revision+event+audit атомарно.
Нативный fixture ещё не закрывает полный синтетический ingress acceptance.
Scheduler, HTTP, own ACL, UI и подключения каналов пока не реализованы.
Изолированные bounded test resources переиспользуются; демо/живые каналы прежние.

Код опубликован: `971fa17fa6b0c83d332b19689df0c51d34f1a6cf`. GitHub API
подтвердил remote HEAD; описание и единственный комментарий ROB-764 прочитаны
обратно, статусы всех11 задач сохранены. [Метаданные](publication.json).
