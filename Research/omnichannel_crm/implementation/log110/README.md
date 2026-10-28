# LOG110 — атомарный аудит выпуска и ротации refresh tokens

ROB765 In Progress. Самостоятельный выпуск refresh token и штатная rotation теперь
используют существующий strict core transaction owner. Rotation заново читает token
под общим user-auth fence и row lock; проверяет owner/workspace/type, security reason
и grace на момент получения блокировки. Original revokedAt сохраняется при повторе.
Изменение старого токена и создание нового имеют единый audit operation/commit.

JWT возвращается только после подтверждённого COMMIT. Ошибка подписи, SQL или audit
откатывает выпуск и rotation; lost ACK не вызывает повтор и не выдаёт credential.
Persisted snapshots проверяются до/после flush, включая изменения через DB triggers.
Вызов с inherited transaction manager отклоняется: ownership нельзя подразумевать.

Каталог refreshToken расширен на create/update: точный tokenOwner с доступом
currentWorkspaceAdministration, redacted createdAt/expiresAt/revokedAt и разрешённая
revokedReason. JWT/value/full context не копируются в audit. Impersonation initiator
разрешается через реальную core membership; исходный срок impersonation issuance
сохранён. Единственный прежний caller с EntityManager — RenewTokenService — переведён
на новый atomic rotateRefreshToken; остальные callers сохраняют свой контракт.

26 новых PostgreSQL cases используют реальные AppTokenEntity, RefreshTokenService,
RenewTokenService и криптографический JWT. Проверены concurrency/grace, отказ журнала,
SQL/sign failure, corrupting triggers, lost actual COMMIT ACK, impersonation и scope.
Workspace-null issuance/rotation сохраняют поведение без выдуманного tenant audit.

Family revoke, standalone sign-in/security-revoke fencing, stateless application JWT,
HTTP/JWT middleware и общий metadata/role audit этим срезом не закрыты. Access JWT
подписывается после refresh commit как прежде; его сбой не означает rollback refresh.
Демо и образ не менялись; GitHub Actions не используется.

1054 tests/34 suites PASS (201.141s); 129 targeted/3 suites PASS. 26 новых PostgreSQL cases. 26 guards PASS; 10 migration checksums неизменны. Types 347/347 roots, 189/189 прежних диагностик, 0 новых/changed-code. 4 local/remote source hashes совпадают.
