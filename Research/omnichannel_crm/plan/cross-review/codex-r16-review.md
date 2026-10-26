# Авторская проверка R16 до получения fresh A

Baseline: b896cee207526a33c475550f317bdacb98fd0bab. Автор знает предыдущие раунды; независимый полный проход выполняет новая Claude-сессия. Эта проверка не называется вторым blind review.

## Проверенная область

- Снимок39 технических документов совпадает с рабочим деревом на старте; пакет лишён Git/history/AGENTS/CLAUDE/SKILL и старых verdict/findings. Source-link prefixes исправлены до запуска, не во время A. Технический текст не редактируется до завершения A.
- 49 выбранных исходников совпадают с pinned729f6236126eddaa68d176fb766bc349b19de11d (LF). Это identity check, не повторное чтение всех source bodies.
-114 явных ссылок на HTML-якоря нормативных owners разрешаются. Локальные Markdown targets/JSON/66 уникальных root IDs/diff scope проходят mechanical verifier.
- Проверены derived связи последней редакции: ConversationMember отделён от ConversationReadCursor; markConversationRead отсылает к sending-ui; T06 принадлежит764/765, минимальный audit writer в phase1 и расширение в phase2a; положительные native APP targetsOnly описания остаются source observations, omni path явно исключает их и использует canonical projection. Новых семантических дефектов этим ограниченным авторским проходом не установлено.

## Оракулы и ограничения

| Риск | Проверка сейчас | Оставшееся доказательство |
|---|---|---|
| Потеря требования/несовместимые owners | Whole-plan fresh A и затем66-root reconciliation, ссылки и source trace | Реализация и T01–T33 |
| Webhook/revoke/ACL | Формальные контракты и source сопоставление reviewer | Real principal/token/revoke integration tests |
| Transaction/audit/cron/доставка | Contract scenarios и dependencies, abstract model | PostgreSQL rollback/concurrency, connector timeout/reconciliation, T19 performance |
| Snapshot загрязнён прежними findings | Preflight и tool-path audit | A coverage должен явно назвать непрочитанное |
| Ошибочные источники | Source hashes/проверка pinned revision | Внешние userbot repos и live account qualification отсутствуют |

Абстрактная модель выполнена:1712 cases,0 failures,23 negative controls пойманы. Она не является тестом новых R15/R16 runtime contracts. G01–G20 с подгейтами остаются выборами владельца до соответствующей активации. Права/секреты/БД/деплой/реальные отправки не менялись.


Дополнительная сверка полного source packet:31414 выбранных tracked исходников/конфигов/тестов плюс27 tracked lock/LICENSE/build файлов,31441 всего. Содержимое совпадает с pinned base после LF-normalization; отсутствующих/подменённых/посторонних файлов нет. Evidence: packet-source-integrity-r16.json. Это проверка происхождения, не чтение всех31441 source bodies.
