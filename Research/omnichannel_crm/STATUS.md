# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG104:

- Native audit owner, реальные snapshots и атомарный audit для Company/Person/Opportunity и покрытых local custom objects; create/update, FILES, soft-delete/restore.
- Public CREATE/upsert, UPDATE и soft-delete/restore используют этот owner. Вложенный CREATE проверяет исходный граф и каждый дочерний вызов после prehook; права и общий rollback сохранены. Графы с неподдерживаемыми объектами или реальными share writes пока остаются на прежнем пути.
- Workspace user-session CREATE и revoke используют core owner; отзыв доступа сохраняется при отказе журнала с явным сигналом. Устаревший cache проверяется по DB revocation.
- Десятая fork migration добавляет индекс audit по workspace/operation. При будущем выкате построение индекса требует остановленных writers.

905 tests/30 suites PASS (174.02s); 109 targeted PASS. 17 новых cases: 15 PostgreSQL и 2 admission-only. 26 guards PASS; 10 migration checksums неизменны. Types 342/342 roots, 189/189 baseline diagnostics, 0 новых/changed-code. 4 local/remote source hashes совпадают.

Это целевые проверки кода. Полный server typecheck не чистый из-за прежних 189 диагностик. Полные HTTP/JWT/private-sharing проверки и новая сборка образа этим срезом не выполнялись.

Открыто: hard-delete/merge, остальные native/system writers и real shares, metadata/roles, отрицательные события после rollback и health/alert. Следующий срез — внутреннее удаление covered CRM записей без входящих FK и непустых FILES с атомарным аудитом; public DESTROY/MERGE требуют дальнейшего покрытия побочных записей.

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog. Собственные права, рабочий интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный и проверенный изолированный кандидат — LOG088; код LOG089–104 не выкатывался. Клиентские сообщения не отправлялись. GitHub Actions не используется.

- [Текущие доказательства LOG104](implementation/log104/README.md).
- [Критерии и остаток ROB765](implementation/rob765-progress.md).
- [Журнал всех шагов](DEVLOG.md).
