# R14 — проверка плана Codex и Claude Code, 26.10.2026

R14: выполнены авторская проверка и свежий полный Claude A (39 документов). A — needs_revision: 1 Medium/6 Low, без Critical/High. Исправления внесены в план; B подтвердил F1–F7 и 63 причины, дополнительно найдены и исправлены 2 Low. Итоговые доказательства — review-result. Последний fresh A был до правок: общий fresh full pass не заявлен. ROB-772 In Progress, ROB-764 Todo; runtime не начат.

## Что проверено и исправлено

[Авторский проход](codex-r14-review.md) записан до чтения Claude; автор знает историю, поэтому не называется вторым слепым reviewer. [Fresh A](claude-r14-full-a.md) выполнен новой сессией `bbe0ee5d-b689-4c16-8ba4-ea22d3d4ee02`, reported model `claude-opus-5-5`, по 39 документам и доступным исходникам pinned 2.52. История/реестр переданы только после A.

- Добавлена schema immutable OmniExecutionReference и ссылки из automation consumers/turns/Commands.
- Закрыт legacy DRAFT/manual workflow start; защищённая операция startOmniWorkflow имеет собственный admission, клиентский runId запрещён.
- Убрана дублирующая формула lock order; добавлен порядок для запроса reconciliation.
- Согласован глобальный commandId в connector с авторизацией исторического owner.
- Send response возвращает актуальные reply/control revisions и mode, UI применяет их монотонно.
- Унифицирован history_import; исправлена разорванная Markdown-таблица.
- Описаны API, durable request и проверка evidence для outcome_unknown; произвольный ручной status override отсутствует.

[Reconciliation B](claude-r14-reconciliation.md) закрывает F1–F7/63 известных причины и добавляет два Low проявления N-6/L-2. Это 9 проявлений в раунде, без новых root IDs. Исправления сделаны в нормативных owners/schema и отражены в API/этапах; не просто записаны пожеланиями. [Finalcheck](claude-r14-finalcheck.md) проверяет lock protocol и исправляет ошибочный довод reviewer о секретности commandId. Command ID не секрет; безопасность опирается на tenant/owner authorization. [Отдельное подтверждение](claude-r14-table-confirmation.md) закрыло B14-2 после удаления оставшейся пустой строки. Все 9 проявлений закрыты в плане.

## Доказательства и пределы

[Механические проверки](verification-r14.json), [45 source files против pinned SHA](source-baseline-r14.json), [audit fresh A](cli-tool-audit-r14-a.json). Абстрактная модель реально выполнена: 1712 случаев, 0 failures, 23 negative controls обнаружены. Она не проверяет новые reference/resolution/editor contracts, SQL concurrency, транспорт и UI. Source coverage и непрочитанные тела файлов перечислены в raw A; внешний connector/userbot code не входил в packet.

ROB-772 пока не закрыта: после fresh A изменена техническая спецификация, B/targeted не являются новым слепым полным проходом. ROB-764 не начата. Разрешённая совместная проверка выполнена; следующий широкий цикл автоматически не запущен. G01–G20, runtime tests, production/cutover не объявляются выполненными. [Предыдущий итог R13](review-result-r13.md) сохранён.
