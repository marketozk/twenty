# LOG109 — security revoke предъявленного refresh token

ROB765 In Progress. SignOut ранее ставил только revokedAt: штатный verifier разрешал
такой токен в rotation grace, а уже rotated token вовсе не менялся. Реальный JWT +
AppTokenEntity + RefreshTokenService regression подтвердил renew после logout до fix.

Verified JWT subject/jti сопоставляются с сохранёнными userId/type. Общий user-auth
exclusive fence предшествует row FOR UPDATE и свежему чтению. Logout сохраняет уже
заданный revokedAt/сильную security reason, добавляет USER_SIGN_OUT там, где причины
ещё нет; остальные context/credential/scope поля проверяются по persisted state.
Повторный logout не создаёт новый success. DeletedAt не исключает отзыв: у AppToken
это обычная колонка, текущий verifier продолжает принимать такую строку.

Используется существующий строгий core transaction owner. Revoke предшествует audit
SAVEPOINT: отказ журнала откатывает только audit и явно сигнализируется как
REFRESH_REVOCATION_AUDIT_UNAVAILABLE; credential остаётся отозванным. Ошибка SQL,
postcondition или восстановления savepoint выходит наружу; unknown COMMIT не повторяется.
SignOut.finally продолжает refresh revoke даже при ошибке session logout.

Закрытый ресурс refreshToken/update имеет tokenOwner={userId,
access:currentWorkspaceAdministration}; workspace берётся из сохранённого токена.
Reason допускается в diff, значение revokedAt скрыто; JWT/value/email/full context не
копируются. Verified impersonation membership разрешается в core user initiator.
Workspace-null токен отзывается без выдуманного tenant audit; это остаётся явной границей.

Два реальных порядка renew/logout проверяют общий advisory fence. Отзыв касается
предъявленного токена: successor, выпущенный до вступления logout в силу, не объявляется
отозванным. Family revoke, standalone issue/rotation audit, stateless application JWT,
общие metadata/roles и остальные ROB765 writers ещё не закрыты.

24 PG cases и 6 descriptor validation cases; настоящий криптографический JWT в fixture,
реальные AppTokenEntity/RefreshTokenService/RenewTokenService и PostgreSQL owner.
JwtWrapper transport/config и HTTP/JWT middleware этим не объявлены проверенными.
Демо/образ/клиентские сообщения не менялись; GitHub Actions не используется.

1028 tests/34 suites PASS (197.443s); 103 targeted/3 suites PASS. 24 PG + 6 descriptor cases. 26 guards PASS; 10 migration checksums неизменны. Types 344/345 roots, 189/189 прежних диагностик, 0 новых/changed-code. 4 local/remote source hashes совпадают.
