# Проверка архитектуры до клиентского запуска

Актуальные определения: [индекс владельцев](../plan/contracts/README.md). Этот документ описывает архитектуру/сценарии; точные контракты и schema находятся у указанных владельцев.

Статус: стратегия и критерии; перечисленные runtime-проверки ещё не выполнены. Используются синтетические контакты/переписка, отдельные Telegram/MAX маршруты и тестовая среда. Интеграция тендерного робота отсутствует.

## Первый сквозной результат

Тестовый клиент пишет в Telegram -> сообщение появляется у менеджера в Twenty -> менеджер отвечает -> клиент получает ответ -> повтор события/команды не создаёт дубль. Затем тот же сценарий MAX. Проверка одного канала не отменяет требование второго.

До больших UI-доработок доказать: сохранение через existing Message pipeline, связывание с контактом, атомарность новых данных/outbox, восстановление после сбоя, путь доставки receipts и собственные права в каждом API. Выбрана Free/self-hosted среда без Enterprise key. До реализации и отрицательных тестов нельзя объявлять реальный shared workspace прошедшим multi-manager приёмку.

## Матрица обязательных сценариев

| Область | Проверка и критерий |
|---|---|
| Входящие | 2 параллельных delivery одного eventId, replay после перезапуска; один Message/эффект. Одинаковый ID с другим телом — конфликт. |
| Транзакция | Авария между Message, link, revision и DomainEvent; либо все изменения есть, либо ни одного. Публикация события до commit невозможна. |
| Дедуп | Worker задержан дольше TTL cache lock; DB constraint/transaction сохраняют единственность. Интеграционный тест на PostgreSQL, не mock. |
| Порядок | Receipt/echo раньше HTTP-ответа, edit до message, старый edit после нового, late sent после timeout; нет потери и регресса состояния. |
| Отправка | Сбой до connector ACK, после ACK, после provider send; неизменный commandId, нет независимого resend из Twenty. MAX unknown не превращается в retry без гарантий. |
| Клиент/маршрут | Одинаковый username у двух клиентов, разные accounts одного Person, чужой route generation; нет склейки по имени и отправки в другой аккаунт. |
| Два менеджера | Оба допущены, авторы видны, чужой третий не читает. Параллельные ответы вызывают stale_view по observedReplyRevision, UI требует подтверждения с новым observedReplyRevision; уже принятый key/hash не отправляется заново. Не сравнивать dispatch с UI revision. |
| Takeover | Барьер перед dispatch vs уже dispatching; старый AI pending отменяется, принятая транспортом команда честно показана как возможная доставка. |
| ИИ | Клиент просит сменить роль/прочитать чужую сделку/использовать другой account. Tool policy отклоняет, в prompt нет чужих данных. Отзыв роли во время run влияет на следующий tool/send. |
| Workflow | Conversation scope сохраняется через очередь/function; нет admin fallback. Повтор event не создаёт второго действия; own echo не вызывает бесконечный цикл. |
| Импорт | Повтор страницы, прерывание, перекрытие live, пропуски файлов; исходные даты/авторы, одна история, checkpoints, явный incomplete report. Ноль внешних ответов и стандартных автоматических record-created действий. |
| Доступ | Прямой GraphQL/REST, generic mutation, relations, groupBy/count/sum, поиск, экспорт, SSE reconnect, AI/tool, скачивание файла после отзыва прав. UI-фильтр не влияет на серверный результат. |
| Сделки/этапы | Запрещённый переход через generic API/AI отклоняется; смена доступного этапа пересчитывает доступ/кеш/подписки. Нельзя читать суммы скрытых сделок. |
| Файлы | Приватный файл после отзыва роли; подмена fileId, внешний SSRF URL, превышение размера, отсутствующее вложение; нет публичного обходного URL. |
| Draft-agent | Изменить права черновика: текущая shared role upstream делает это риском; обеспечить отдельную role/policy version по ADR-05. Права опубликованного агента не меняются до публикации. |
| Отключение | Disable account сохраняет историю; delete/purge требует отдельного действия и проверенного плана хранения. |
| Независимость | При недоступном SaleBot на тестовом маршруте работают receive/send/history/AI; в цепочке нет обязательных SaleBot credentials и запросов. |

## Существующие тестовые опоры

Дополнения ревью плана: (1) пауза generic AI/workflow tool между epoch check и CRM write, конкурирующий takeover/revoke, общий transaction fence и audit; оба порядка должны давать согласованный результат; (2) import→live, live→import и параллельная обработка одинакового сообщения до/после activationBoundary; дедупликация текста не теряет допустимый новый live-эффект и не активирует историю. Неизвестная позиция требует reconciliation. Собственный аудит проверяется по [08-audit.md](08-audit.md), включая rollback и сквозные ограничения чтения.

Пути ниже найдены в принятом snapshot; они проверяют части upstream, но не наш новый модуль:

- Server integration: `test/integration/metadata/suites/message-channel/app-message-channels.integration-spec.ts`.
- Server integration: `test/integration/graphql/suites/person-participant-rematch.integration-spec.ts`.
- Server integration: `test/integration/ai/suites/ask-ai-application-token-tools.integration-spec.ts`.
- Server integration: `test/integration/graphql/suites/workflow/core-workflow-draft-step-resources.integration-spec.ts`.
- Server unit: `src/engine/metadata-modules/ai/ai-agent-execution/utils/__tests__/build-agent-role-permission-config.util.spec.ts`.
- Front unit: `packages/twenty-front/src/modules/ai/components/__tests__/AiChatThreadDetailsDropdown.test.tsx`.

Server-пути относительны `packages/twenty-server/`. Конкретные команды общего setup/integration брать из CLAUDE.md и Nx targets выбранной версии; DB reset запускать только на отдельной тестовой БД. Сначала узкие unit/contract, затем PostgreSQL integration с fault injection, после них UI/e2e и реальные тестовые маршруты.

## Переход версии и эксплуатация

1. Сборка Linux/Node совместимой версии из фиксированного SHA, проверка production image и единого server/worker образа.
2. Восстановление копии БД и файлов, миграции 2.52, `upgrade:status`, проверка существующих demo records/workflows; health не заменяет проверку upgrade.
3. Отработка восстановления БД/файлов/очередей и reconciliation внешних результатов; откат кода не отменяет уже отправленные сообщения.
4. Наблюдение backlog/latency/unknown jobs и отключений аккаунтов. Численные пороги назначить после оценки нагрузки.
5. Для выбранного маршрута доказать дренирование старого отправителя, смену поколения, replay входящих и отсутствие двойной отправки. Живой переход требует отдельного разрешения.

Критерий готовности плана: выбраны права/хранение и зафиксированы точные точки изменения по [карте исходников](../implementation/integration-map.md), route/command contract и тесты. Отдельный persistence spike снят пользователем: rollback/concurrency проверяются постоянными тестами реализации. Тестовые аккаунты и доступная история нужны для приёмки каналов, а не для подтверждения доступных чтением свойств кода. Документы сами по себе не являются успешной квалификацией новой функции.
