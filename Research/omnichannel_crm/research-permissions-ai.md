# Исследование: права, ИИ и автоматизации Twenty

Статус документа: датированное исследование закреплённых исходников; описания тогдашней среды и «следующих шагов» ниже исторические. Текущие результаты обновления, состояние плана и порядок работы — [STATUS.md](STATUS.md). Нормативные решения по автоматизации — [design/09](design/09-automation-contract.md); runtime этой доработки ещё не написан.

Дата: 26.10.2026. Исследована ревизия upstream `729f6236126eddaa68d176fb766bc349b19de11d`, поверх которой находятся документы проекта. Это факты о коде, а не готовая конфигурация прав или выбранная архитектура.

## Версии и границы проверки

- В исходниках `packages/twenty-server/src/engine/core-modules/upgrade/constants/twenty-current-version.constant.ts:11` указана **2.52.0**.
- Read-only `docker ps` с фильтром Compose-проекта `twenty-demo` подтвердил: server и worker используют образ **`twentycrm/twenty:v2.50.0`**, БД — `postgres:16`, Redis — `redis:7.4-alpine`. Server, БД и Redis healthy; worker запущен. Это проверка образов и состояния контейнеров, не аудит схемы БД, лицензии или настроенного провайдера ИИ.
- Рабочая копия исходников не равна установленной версии. Обновление демо, миграции и перенос данных не выполнялись. Зависимости нового checkout не установлены (`node_modules` отсутствует), upstream-тесты Twenty здесь не запускались.

## Карта доказательств

Пути ниже относительно корня проекта; номера строк относятся к исследованной ревизии.

| Код | Подтверждённый механизм |
|---|---|
| `packages/twenty-server/src/engine/metadata-modules/role/role.entity.ts:28` | Роль: общие права на записи, настройки, инструменты; назначение пользователям, агентам, API-ключам; объектные/полевые ограничения. |
| `packages/twenty-server/src/engine/metadata-modules/object-permission/field-permission/field-permission.entity.ts:31` | `canReadFieldValue`, `canUpdateFieldValue`; права на всё поле, а не отдельное значение этапа. |
| `packages/twenty-server/src/engine/metadata-modules/permission-flag/constants/standard-permission-flag-definitions.constant.ts:42` | Различаются ROLES, DATA_MODEL, WORKFLOWS, APPLICATIONS, AI_SETTINGS и AI. |
| `packages/twenty-server/src/engine/metadata-modules/row-level-permission-predicate/services/row-level-permission-predicate.service.ts:490` | `hasRowLevelPermissionFeature`: одновременно проверяет валидность Enterprise-плана и entitlement RLS. Файл помечен Enterprise. |
| `packages/twenty-server/src/engine/twenty-orm/utils/resolve-row-level-permission-record-filter.util.ts:14` | Условия строятся из ролей и metadata; текущий workspace member подставляется для user-auth context. |
| `packages/twenty-server/src/engine/twenty-orm/utils/build-row-access-policy.util.ts:17` | Серверная политика сочетает права объекта, RLS и sharing; SYSTEM-context имеет отдельное поведение. |
| `packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts:660` | `update`/`updateMany` идут через общий механизм мутаций; ограничения применяются в ORM, а не только в интерфейсе. |
| `packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/utils/field-metadata/compute-opportunity-standard-flat-field-metadata.util.ts:203` | Этап сделки — SELECT-поле `stage` с набором options. |
| `packages/twenty-server/src/engine/metadata-modules/validation-rule/entities/validation-rule.entity.ts:1` | Отдельный механизм validation rules; он также Enterprise. |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/utils/build-agent-role-permission-config.util.ts:4` | Права запуска агента — `intersectionOf` роли агента и ограничивающих ролей запуска. |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/services/agent-run.service.ts:462` | Учитывает run-as пользователя, вызывающую сторону и роль приложения; формирует actor и контекст. |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-execution/services/agent-toolset.service.ts:158` | Каталог и набор инструментов строятся с rolePermissionConfig; есть разные стратегии доступа и исключения инструментов. |
| `packages/twenty-server/src/engine/core-modules/tool-provider/services/tool-registry.service.ts:337` | `resolveAndExecute` заново ищет инструмент в каталоге текущего контекста и передаёт его executor. |
| `packages/twenty-server/src/engine/core-modules/tool-provider/providers/logic-function-tool.provider.ts:44` | Logic functions с tool trigger доступны как инструменты; учитывается принадлежность приложению. |
| `packages/twenty-server/src/engine/core-modules/tool-provider/services/tool-executor.service.ts:359` | `dispatchLogicFunction` передаёт workspace, payload, userId/userWorkspaceId. Сам по себе этот вызов не является авторизацией фирмы в системе робота. |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-models/services/sdk-provider-factory.service.ts:131` | Фабрика провайдеров: OpenAI, Anthropic, Google, Mistral, xAI, Bedrock, Azure, OpenAI-compatible и TypeSafe AI. |
| `packages/twenty-server/src/engine/metadata-modules/ai/ai-models/services/ai-model-registry.service.ts:110` | Реестр моделей обновляется по конфигурации и доступности custom providers. |
| `packages/twenty-server/src/modules/workflow/workflow-executor/services/workflow-execution-context.service.ts:94` | Контекст workflow определяется инициатором/приложением; роли разрешаются на сервере. |
| `packages/twenty-server/src/modules/workflow/workflow-executor/workflow-actions/send-chat-message/send-chat-message.workflow-action.ts:81` | Сообщение адресуется workspace member через внутренний conversation service, с ключом идемпотентности. Это не Telegram/MAX-транспорт. |

## Права менеджеров, сделки и этапы

Отдельные сотрудники, роли, общие права по объектам, ограничения полей и настройки уже представлены в ядре. Их можно исследовать как основу R-09/R-11; создавать параллельную систему входа без причины не требуется.

Условие «сотрудник видит только свои сделки или сделки на заданном этапе» — ограничение конкретных записей. Найденная штатная реализация RLS коммерческая. Наличие исходников в форке не превращает её в свободно лицензируемую часть: корневой [LICENSE](../../LICENSE) отдельно описывает файлы с `@license Enterprise`. В сервисе RLS присутствует проверка лицензии; выключенный облачный billing не отменяет `enterprisePlanService.isValid()`.

В общей политике также есть record sharing. Персональное разрешение на запись в некоторых режимах может расширить доступ за пределы фильтра роли: это явно проверяется в `build-row-access-policy.util.spec.ts:322`. Режим ограничения sharing рамками роли проверяется на строке 334. Поэтому конфигурацию «только свои» нельзя считать проверенной до теста совместного действия ролей, sharing и наследуемых связей.

Для этапов нужно различать:

1. Видимость всей сделки по значению `stage` — предмет RLS/серверной политики записи.
2. Видимость и редактирование самого поля `stage` — штатные field permissions.
3. Право менять справочник этапов — право на metadata/data model, отдельное от редактирования сделки.
4. Допустимый переход «из A в B для сотрудника X» — готовая специализированная матрица переходов в прочитанных путях не найдена. SELECT-field и RLS её не доказывают.

В ORM есть транзакционная валидация записанных данных (`runWithValidationRules`, `workspace-repository.ts:777`; `validate-records-against-validation-rules.util.ts`). Но validation rules — тоже Enterprise, и изученные аргументы описывают записанные записи/связи, а не готовый движок переходов с предыдущим этапом и ролью сотрудника. Возможность выразить нужные бизнес-правила этим механизмом остаётся отдельной проверкой Design.

## Переиспользование ИИ

Вместо новой независимой интеграции с LLM уже есть:

- реестр моделей и фабрика провайдеров;
- определения агентов, инструкции skills, выбор modelId, структурированный результат;
- выполнение агентов, история, инструменты и контекст пользователя/приложения;
- запуск через workflow и приложение, ожидание событий и участия человека;
- регистрация logic functions как прикладных tools.

SDK-документ [Skills & Agents](../../packages/twenty-docs/developers/extend/apps/logic/skills-and-agents.mdx) прямо обозначает возможности как alpha. Это основание для переиспользования и проверки совместимости, а не гарантия стабильности контрактов между 2.50 и 2.52.

Цепочка в коде: caller/run-as → контекст и роли (`AgentRunService`) → пересечение ролей агента/приложения/вызывающей стороны → каталог tools → executor → конкретная операция. Это позволяет проектировать широкие прикладные возможности ИИ без выдачи ему неограниченного системного доступа.

Текущие роли Twenty ограничивают Twenty-объекты. Они не знают, какие фирмы тендерного робота принадлежат клиенту из Telegram/MAX. Любой будущий tool для робота должен исполняться с проверенной связью диалога, клиента и разрешённых фирм. Текст сообщения клиента или параметр firm_id, предложенный моделью, такую связь не устанавливает.

В найденном `dispatchLogicFunction` передаются user/workspace identity, но не вся структура agent rolePermissionConfig. Поэтому нельзя объявлять произвольную logic function автоматически ограниченной всеми правами агента: на этапе Design надо проследить контекст её runtime/API credentials и внешнюю авторизацию конкретного tool. Для штатных CRUD-инструментов передача rolePermissionConfig в executor видна непосредственно в коде.

«ИИ может отправлять сообщения» и «результат генерации гарантированно доставлен клиенту» — разные события. Требуются связь с заданием транспорта, отмена устаревшего ответа при вмешательстве менеджера и аудит автора. Наличие agent runner само по себе не подтверждает готовность этих сценариев для внешних каналов.

## Рабочие процессы

Union в `workflow-action.type.ts:40` содержит: код, logic function, email/draft, внутреннее chat message, calendar event, CRUD/upsert/find/pick record, форму, filter/if-else, HTTP request, AI agent/classify, iterator, delay, wait-for-event.

Это готовая база автоматизаций. Однако стандартный `SEND_CHAT_MESSAGE` отправляет во внутренний Inbox Twenty. Для Telegram/MAX требуется действие, связанное с коннектором и его статусами доставки; существующий блок нельзя выдавать за уже работающий мессенджерный коннектор.

`WorkflowExecutionContextService` различает ручной запуск от лица workspace member и приложение. Для автоматического запуска без явного приложения используется standard application; если у него отсутствует defaultRoleId, предусмотрен поиск роли Admin (`:218`). Поэтому сообщение извне не должно автоматически превращаться в запуск с неограниченным системным контекстом. Нужны явные инициатор, область клиента и права выполняемого действия.

## Лицензионные и тарифные границы, проверенные 26.10.2026

| Возможность | Наблюдение |
|---|---|
| RLS конкретных записей | Штатная функция Organization; Enterprise-marked файлы и серверная проверка. |
| Validation rules | Enterprise-marked entity/service/ORM validation. Это нужно учитывать при выборе реализации переходов. |
| Встроенные AI-провайдеры self-hosted | Официальный FAQ допускает их на Free; расход провайдера оплачивается отдельно по его условиям. |
| Custom endpoint / частный gateway / локальная модель | В изученной версии бесплатно до **25 seats**, выше требуется Organization. `MAX_SEATS_WITHOUT_ENTERPRISE_KEY = 25`; `hasCustomAiProviderAccess` учитывает billing, лицензию и seatCount. Это отдельное условие, не общий запрет Free на ИИ. |
| SDK-приложение через опубликованные интерфейсы | В LICENSE есть Application Exception; это не распространяется автоматически на правки самого ядра или Enterprise-файлов. |

Первичные источники: [официальные permissions](https://docs.twenty.com/user-guide/permissions-access/capabilities/permissions), [AI FAQ](https://docs.twenty.com/user-guide/ai/how-tos/ai-faq), [LICENSE upstream](https://github.com/twentyhq/twenty/blob/729f6236126eddaa68d176fb766bc349b19de11d/LICENSE). Тарифы и лимиты привязаны к дате и версии. Наличие действующей лицензии или custom provider на демо в этой работе не проверялось. Лицензионные условия зафиксированы как ограничение проекта; платная редакция не выбрана и обход проверки не предлагается.

## Существующие проверки и недостающая квалификация

Найдены и прочитаны соответствующие участки тестов, но тесты Twenty не запускались:

- `src/engine/twenty-orm/utils/__tests__/build-row-access-policy.util.spec.ts`: объектные права, private/inherited sharing, RLS и персональные grants.
- `src/engine/metadata-modules/ai/ai-agent-execution/utils/__tests__/build-agent-role-permission-config.util.spec.ts`: пересечение ролей и отсутствие роли.
- `test/integration/graphql/suites/group-by-with-records-rls.integration-spec.ts`, `relation-join-rls.integration-spec.ts`, `test/integration/record-export/record-export.integration-spec.ts`: агрегаты, связи, экспорт.
- `test/integration/graphql/suites/workflow/application-workflow-execution-permissions.integration-spec.ts`: права workflow приложения.
- `test/integration/graphql/suites/user-session/successful-agent-run-tool-role-for-caller.integration-spec.ts`: контекст роли вызывающей стороны для agent tools.

Пути тестов в списке относительно `packages/twenty-server/`.

До утверждения архитектуры нужно проверить на выбранной версии: роль сотрудника/ИИ/API; недоступность чужой сделки через UI/API/поиск/связи/агрегаты/экспорт; смену видимости после перехода этапа; sharing; полномочия приложения и logic function; выдачу вложений; перенос caller identity через workflow. Эти проверки не заменяются скрытием колонок или инструкцией в prompt.
