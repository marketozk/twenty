# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG112:

- Native audit owner, реальные snapshots и атомарный audit для Company/Person/Opportunity и покрытых local custom objects; create/update, FILES, soft-delete/restore.
- Public CREATE/upsert, UPDATE и soft-delete/restore используют этот owner. Вложенный CREATE проверяет исходный граф и каждый дочерний вызов после prehook; права и общий rollback сохранены. Графы с неподдерживаемыми объектами или реальными share writes пока остаются на прежнем пути.
- Workspace user-session CREATE и revoke используют core owner; отзыв доступа сохраняется при отказе журнала с явным сигналом. Устаревший cache проверяется по DB revocation. LOG109 добавляет немедленный security revoke предъявленного refresh token при logout и его audit; audit failure не восстанавливает credential. LOG110 добавляет атомарные выпуск и ротацию workspace refresh tokens: старый и новый токены имеют общий operation/commit; ошибка журнала отменяет выдачу.
- Role CREATE/UPDATE из GraphQL/AI tool имеет strict metadata owner, actual DB snapshots и audit; ROLES/self-lockout сохранены. Role delete/assignments и остальные metadata writers ещё открыты.
- Десятая fork migration добавляет индекс audit по workspace/operation. При будущем выкате построение индекса требует остановленных writers.

1108 tests/35 suites PASS (198.532s); 54 targeted PG/descriptor + 11 existing role-tool unit tests PASS. 22 новых PG cases. 26 guards PASS; 10 migration checksums неизменны. Types 352/352 roots, 218/218 прежних диагностик, 0 новых/changed-code. 8 local/remote source hashes совпадают.

Это целевые проверки кода. Полный server typecheck не чистый из-за 218 прежних диагностик в расширенном metadata/auth графе. Полные HTTP/JWT/private-sharing проверки и новая сборка образа этим срезом не выполнялись.

Открыто: public DESTROY/MERGE и FK side effects, остальные native/system writers и real shares, остальные metadata/role mutations, отрицательные события после rollback и health/alert. Внутреннее leaf hard-delete покрыто LOG105; direct SET_NULL covered children — LOG106, direct CASCADE — LOG108. LOG107 закрывает неаудированные ON UPDATE effects защитным отказом. Остаются остальные FK effects и безопасное подключение публичных destroy/merge owners.

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog. Собственные права, рабочий интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный и проверенный изолированный кандидат — LOG088; код LOG089–112 не выкатывался. Клиентские сообщения не отправлялись. GitHub Actions не используется.

- [Текущие доказательства LOG112](implementation/log112/README.md).
- [Критерии и остаток ROB765](implementation/rob765-progress.md).
- [Журнал всех шагов](DEVLOG.md).
