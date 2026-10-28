# Twenty CRM: общение с клиентами вместо SaleBot

Дата фиксации: 26.10.2026 (Москва).

Цель: сделать Twenty единым рабочим местом для общения с клиентами Telegram/MAX, CRM, автоматизаций и ИИ. В конечном решении SaleBot не требуется для работы переписки. По последнему уточнению пользователя тендерный робот и интеграция с ним не входят в проект.

Уточнение 26.10.2026: несколько менеджеров с отдельными входами и правами могут участвовать в одном клиентском диалоге; ИИ должен иметь максимальные прикладные полномочия внутри CRM по установленным правилам. Основной вариант каналов — существующие юзерботы Telegram/MAX; они остаются транспортом сообщений.

## Документы проекта

- [Краткая сводка и следующие действия](Research/omnichannel_crm/STATUS.md) — что сделано, текущий допуск и порядок продолжения.

- [Журнал разработки](Research/omnichannel_crm/DEVLOG.md) — выполненные шаги, проверки, коммиты, ограничения и следующий шаг.
- [Проект в Linear](https://linear.app/robotrts/project/twenty-crm-obshenie-s-klientami-eccda8a60c7b) — актуальные задачи и зависимости; [карта задач](Research/omnichannel_crm/linear.md).

- [Требования](Research/omnichannel_crm/requirements.md) — подтверждённые решения, функциональный состав и критерии результата.
- [Архитектура v1](Research/omnichannel_crm/design/01-architecture.md) — модули, потоки, данные, API и проверки; выбраны собственные права без подписки Twenty. [Что переиспользуем и пишем сами](Research/omnichannel_crm/design/07-license-boundary.md).
- [Исследование](Research/omnichannel_crm/research.md) — проверенные возможности Twenty и коннекторов, матрица переиспользования и ограничения. Прежний раздел об API робота исключён из действующего объёма.
- [Принятая база 2.52](Research/omnichannel_crm/reuse-2.52.md) — точный снимок исходников, выбранные изменения, готовый API внешней переписки и проверки перед запуском.
- [Обновление демо до 2.51.0](Research/twenty_upgrade_2_51/report.md) — результат, проверки и резервная копия от 26.10.2026.
- [Технический план](Research/omnichannel_crm/plan/README.md) — восемь этапов с файлами, зависимостями, проверками и откатом. [Дорожная карта](Research/omnichannel_crm/plan/roadmap.md).
- [Единые определения и владельцы контрактов](Research/omnichannel_crm/plan/contracts/README.md) — где менять правила без дублирования.
- [Подробная спецификация всего проекта](Research/omnichannel_crm/plan/implementation-spec.md) — контракты данных, транзакций, API, прав, чатов, ИИ, истории и эксплуатации. [Кроссревью с Claude Code](Research/omnichannel_crm/plan/cross-review/registry.md); задача [ROB-772](https://linear.app/robotrts/issue/ROB-772) предшествует реализации ROB-764.
- [Аудит действий](Research/omnichannel_crm/design/08-audit.md) — собственный журнал CRM, сообщений, прав, ИИ и workflow без подписки Twenty.
- [Открытые вопросы](Research/omnichannel_crm/open-questions.md) — группы, подключение аккаунтов, импорт, полномочия ИИ и масштаб.
- [Принятые решения](Research/omnichannel_crm/decisions.md) — что уже решил пользователь и что пока нельзя считать выбранной архитектурой.
- [Стартовая формулировка](Research/omnichannel_crm/00-prompt-opening.md).

## Код и репозитории

Эта папка — локальная копия нашего форка: https://github.com/marketozk/twenty.

- `origin` — `marketozk/twenty`, наши изменения.
- `upstream` — `twentyhq/twenty`, исходный проект.
- Начальная ревизия форка: `729f6236126eddaa68d176fb766bc349b19de11d`.
- Эта же ревизия принята как база разработки 2.52 по просьбе пользователя; [перечень SHA](Research/omnichannel_crm/upstream-2.52.json). Все её исходники уже присутствуют, повторный cherry-pick не нужен. Это снимок разработки, не опубликованный стабильный релиз; с 26.10.2026 он является базой работающего экземпляра.
- Ветка постановки задачи: `codex/omnichannel-requirements`.
- `packages/` — исходники Twenty; структура upstream сохранена.
- `Research/omnichannel_crm/` — постановка задачи и дальнейшие исследования/проектирование.

Новый код этой доработки размещается в этом проекте. Архитектура v1 выбирает модули `omnichannel` в twenty-front/server/shared и отдельный транспорт. Каноническая переписка остаётся в Message/MessageThread Twenty. Реализуются server foundations: схемы, миграции, аудит и bootstrap; публичный API, UI и транспорт ещё впереди.

Исходники существующих Telegram/MAX-коннекторов пока остаются в их прежних проектах. Перенос или выделение нужных частей должен сохранить лицензии, историю и границы сервисов; копировать весь старый проект вместе с конфигами, сессиями и данными нельзя. Сейчас эти компоненты не перенесены и не изменены.

## Текущее состояние

26.10.2026 выполнены [пункты 1–5](Research/omnichannel_crm/plan/current-steps.md). Единственный экземпляр на localhost:2020 обновлён нашим образом `marketozk/twenty:2.52-44e1449c`. Исходники образа — полный Git commit `44e1449c`; runtime соответствует закреплённой базе 2.52. Следующие коммиты содержат операционный скрипт и документацию.

Сборка server/front успешна. Миграции instance/workspace — Up to date, 0 failed. Содержимое семи проверенных CRM-таблиц совпало до/после; server/worker запущены, HTTP 200, обзор/сделки/процессы открываются в браузере. Новая резервная копия не создавалась по просьбе пользователя. БД, Redis, прежние копии и остальные сервисы сохранены. [Подробный отчёт](Research/omnichannel_crm/implementation/version-and-deploy.md).

Завершено исследование транзакций, API/ORM, аудита, прав, ИИ и workflow. [Карта реализации](Research/omnichannel_crm/implementation/integration-map.md) фиксирует владельцев транзакций, точные файлы и изменения, а также проверки будущей реализации. Служебные таблицы выбраны в core той же БД, вне autogenerated CRUD. План обновлён по исходникам; прежние отдельный постоянный стенд и предварительные прототипы отменены.

Чаты, собственные права, полный охват аудита CRM и управление ИИ пока не реализованы. Подписка Twenty и тендерный робот исключены из объёма. Маршруты сообщений SaleBot не переключались. ROB-764 завершён; текущий этап — ROB-765: расширение надёжного аудита на native CRM writers. Ход разработки фиксируем в [DEVLOG](Research/omnichannel_crm/DEVLOG.md) и [Linear](Research/omnichannel_crm/linear.md).

Перед реализацией ROB-764 пользователь расширил планирование на весь проект: ROB-772, подробная спецификация и независимое кроссревью с Claude Code. Актуальный вердикт и незакрытые вопросы находятся в [реестре](Research/omnichannel_crm/plan/cross-review/registry.md). Ранние положительные отзывы об архитектуре не заменяют этот проход. 33 группы будущих проверок и [карта покрытия требований](Research/omnichannel_crm/plan/coverage.md) относятся к ещё не написанным функциям; работающий экземпляр этим планированием не меняется.

ROB764 завершена по LOG088; ROB765 In Progress. LOG089–093 добавили native audit owner для updates Company/Person/Opportunity, включая FILES, и индекс операций; LOG094 автоматически подключает стандартные REST/GraphQL UPDATE. LOG095/096 добавляют внутренний CREATE, включая вложения; LOG097 — внутренние create/update пользовательских объектов; LOG098 — soft-delete/restore и стандартные public DELETE/RESTORE. LOG101 подключает обычный public CREATE covered standard/custom объектов без nested/share writes; LOG102 добавляет flat public upsert, LOG103 — public custom UPDATE/soft-delete/restore, LOG104 — bounded nested public CREATE/upsert; LOG105 — internal leaf hard-delete. LOG099 добавляет аудит создания workspace user-session; LOG100 — безопасный отзыв с audit SAVEPOINT и проверкой устаревшего кэша. Общий аудит CRM пока не готов; код после LOG088 не выкатывался. Актуальные проверки, ограничения и следующий шаг — в [STATUS](Research/omnichannel_crm/STATUS.md).
[Доказательства и ограничения](Research/omnichannel_crm/implementation/log088/README.md).

Предыдущая порция LOG-022: реализованы минимальный аудит и атомарное создание
inactive binding/disabled policy v0 с receipt, текущей проверкой прав через
обязательный authorizer и защитой от повторов. К первым9 core entities добавлены
audit entry и PolicyMutationReceipt. Runtime gate проверяет append-only privileges.
Прошли81 PostgreSQL,25 Python guard/checksum и7 shell tests, focused strict typecheck.
[Доказательства и ограничения](Research/omnichannel_crm/implementation/log022/README.md).
Демо не обновлялось. Схема расширена в LOG-024/025; следующие работы — ingress/outbox;
публичный API, собственные права и чаты ещё не готовы. ROB-772 Done как планирование;
полного нового архитектурного review pass не заявлено.

Установка и команды upstream находятся в [README.md](README.md) и [CLAUDE.md](CLAUDE.md). Исходники и документы хранятся в этой папке на Рабочем столе; сборка выполнена на Schrodinger официальным Dockerfile с ограничением ресурсов.
