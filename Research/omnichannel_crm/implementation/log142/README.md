# LOG142 — настройки календарного канала и условный сброс

Публичный updateCalendarChannel использует закрытый core owner: настройки,
условный reset и безопасный audit diff сохраняются одним COMMIT. Проверяются
текущий владелец аккаунта, активный пользователь и membership, точные изменения
строки и поздние эффекты. Ответ API остаётся снимком после настроек, до reset.

После подтверждённого COMMIT очищается только текущий account-scoped cache key.
Неизвестный исход транзакции не запускает очистку; её ошибка после сохранения
передаётся как CoreAuditPostCommitError. Durable cache delivery не заявляется.

- [Результаты](results.json), [исходники](source-snapshot.json), [типы](typecheck-differential.json).
- [Целевые проверки](target.log), [регрессия](regression.log), [guards](guards.log).
- [Ревью](review.md), [следующая граница](next-boundary.md).

ROB765 остаётся In Progress. Provider save/matching, остальные core writers,
сборка, выкат и полный HTTP/JWT проход этим изменением не закрываются.
GitHub Actions не используется.
