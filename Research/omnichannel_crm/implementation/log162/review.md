# LOG162 - Независимое ревью кода: аудит встроенных мутаций `roleTarget` в `AgentService`

## Вердикт

Блокеров нет. Ветка `agentMetadata` в `runAuditedRoleAssignment` закрывает все *запланированные* мутации `core."roleTarget"` из `createOneAgent`, `updateOneAgent` и `deleteManyAgents`. Проверка формы действий, сопоставления, блокировки, before-образ до `work(runner)` и повторные проверки после `work` и после `audit.flush()` сделаны fail-closed. Отклонение от Finding 3 из `design-review.md` верное.

Найдена **1 дыра уровня major**: `deleteManyAgents` решает, нужен ли аудит, по снимку кэша. Если снимок устарел, агент удаляется в транзакции без аудита, и `ON DELETE CASCADE` удаляет `roleTarget`, не оставив записи аудита. Кроме того, есть 3 замечания уровня minor и мелочи (nit).

Ревью выполнено чтением кода по актуальному состоянию файлов, включая правки после старта: `create-agent.tool.ts` и `delete-agent.tool.ts` теперь используют `isUndefined` из `@sniptt/guards`, а `mode` для `agentMetadata` задаёт сама `withRoleAssignmentAudit`. Тесты не запускались, как и было указано.

## Что подтверждено

1. **Форма действий** (`role-assignment-audit.ts:482-497`). Допускаются только `agent`/`roleTarget`, и только `create`/`delete` для `roleTarget`.
   - create (`499-559`): ровно один `agent.create` и один `roleTarget.create`. `id` и `universalIdentifier` агента совпадают с запросом. Цель агентская (`userWorkspaceId`/`apiKeyId` равны null). Роль сверяется через `mappings.roles`.
   - update (`702-794`): агентских `update`-действий 0..1, без `id`, `universalIdentifier` агента сверяется. Количество `delete`/`create` для `roleTarget` следует из `expectedDeletedRoleTargetId`/`roleId`. Порядок проверяется по подмножеству `roleTarget`, поэтому `agent.update` между ними (`compute-ordered-migration-actions.util.ts:61-68`) не мешает. Удаляемая цель сверяется через `mappings.targets`, агент - через `mappings.agents`.
   - delete (`1001-1049`): строгое взаимно однозначное соответствие удаляемых `roleTarget` и `request.targets`, дубликаты отсекаются. Каждый агент из `targets` входит в число удаляемых.
2. **Порядок и режимы блокировок** совпадают с существующими ветками: `workspace FOR NO KEY UPDATE` → `application FOR SHARE` → `agent` → `roleTarget FOR UPDATE` → `role FOR SHARE`. Блокировка строки workspace сериализует все аудируемые ролевые операции воркспейса. `FOR NO KEY UPDATE` совместим с `KEY SHARE`, который берут FK при `INSERT` агента и `roleTarget`.
3. **Каскад и before-образ.** В delete-ветке строки `roleTarget` для **всех** удаляемых агентов (`"agentId"=ANY(plannedAgentDeleteIds)`, `:1081-1110`) читаются и блокируются до `work(runner)`. Лишняя строка ломает равенство числа строк, и транзакция откатывается (Finding 2 закрыт). После `work` и после `flush` проверяется, что не осталось ни агентов, ни привязок (`:1130-1166`).
4. **Сверка с записанным.** Ожидаемая строка `roleTarget` и `applicationId` агента сверяются с приложением миграции, а именно его и пишут `create-agent-action-handler.service.ts:40` и `create-role-target-action-handler.service.ts:48`. Метки времени сверяются с точностью до микросекунд. Аудит берёт `projectRoleTargetAuditFields` из фактической строки, `operationId` общий.
5. **Identity.** Снимок (`captureRoleAuditIdentity` + `captureRoleAuditOperation`) делается синхронно до первого `await` (`agent.service.ts:89-112`). Подмена `input`/`auditIdentity` после вызова ничего не обходит: обёртка всё равно вызывает `requireAuditIdentity()` по фактическому плану (`:190`, `:298`, `:406`). Вложенный scope отсекается синхронно.
6. **Отклонение от Finding 3 верное.** Если передать приложение самого агента, то для стандартного агента `isCallerTwentyStandardApp` станет true и снимется запрет на update/delete (`flat-agent-validator.service.ts:106-119`, `:157-170`). Заодно для любого агента пройдёт проверка владельца триггеров (`:207-216`, `validate-agent-triggers-caller-application.util.ts:15-21`). Проверки приложения в аудите при этом корректны и для агентов чужих приложений: целевое приложение плана сверяется с приложением агента, а сохранённая строка - с приложением миграции, то есть с тем, что реально записано. Явный `input.applicationId` в `createOneAgent` никто не передаёт (`@HideField`), так что там всегда workspace custom.
7. **Остальные вызывающие и правила дома.** `update-workflow-agent.tool.ts:125` и `dev-seeder-workflow-pending-input.workspace-service.ts:188` не трогают `roleId` и работают как прежде. Системные `systemActorId` в workflow валидны. Других потребителей `flatRoleTargetToUpdate` нет. Именованные экспорты на месте, `any` нет, используются `isDefined`/`isUndefined`.

## Замечания

### F1 (major) - `deleteManyAgents`: устаревший кэш ведёт к неаудируемому каскадному удалению `roleTarget`

- **Где:** `agent.service.ts:401-406`, `:430-443`. Неаудируемый путь - `workspace-migration-runner.service.ts:544+`, затем `delete-agent-action-handler.service.ts:38`, затем `role-target.entity.ts:54-58` (`onDelete: 'CASCADE'`).
- **Сценарий.** У агента X в снимке `flatRoleTargetByAgentIdMaps` нет роли, поэтому `roleTargetsToDelete=[]` и миграция идёт без scope. Параллельно `updateOneAgent({roleId})` или `assignRoleToAgent` (аудируемая транзакция A) создаёт привязку R и коммитит её вместе с записью аудита `create`. `DELETE core.agent` в транзакции B ждёт `FOR SHARE` транзакции A, затем выполняется, и каскад удаляет уже закоммиченную R. Записи аудита `delete` нет, в журнале R числится созданной и не удалённой. Билдер этого не ловит: `agent` → `{ role: true }`, привязки `roleTarget` он не загружает. То же самое происходит при долго устаревшем кэше: runner лишь логирует сбой инвалидации. И в `runWorkflowVersionStepDeletionSideEffects` R берётся из БД, а `deleteManyAgents` - из кэша.
- **Исправление.** При аудируемой identity всегда входить в delete-ветку. Нужно разрешить пустой `targets`: блокировать `roleTarget WHERE "agentId"=ANY(planned)` и требовать точное совпадение, то есть ноль строк. Для вызовов без аудируемой identity нужна fail-closed проверка в той же транзакции. Пример: guard в runner, который вне assignment-scope при `agent.delete` блокирует привязки агента `FOR UPDATE` и бросает ошибку, если они есть. Регрессия: в кэше роли нет, в `beforeRunnerRun` вставлена R → вызов отклонён, агент и R на месте.

### F2 (minor) - комментарий расходится с проверкой в `updateOneAgent`

- **Где:** `agent.service.ts:89-90` против `:232-234`.
- **Сценарий.** Комментарий утверждает «only enforced once a roleTarget changes». Фактически проверка срабатывает при любом `input.roleId !== undefined`. Поэтому запрос `{ id, roleId: <текущая роль> }` (no-op) или `{ id, roleId: null }` для агента без роли от `pendingActivationUser` либо от `update_agent` без `authContext` отклоняется ошибкой `Role mutation requires authenticated audit identity`, хотя `roleTarget` не меняется. До LOG162 такие запросы проходили. Фронтенд `roleId` в `updateOneAgent` не шлёт, так что затронуты только API и инструменты.
- **Исправление.** Привести комментарий в соответствие: проверка срабатывает, как только запрошено изменение роли. Ранний отказ до первого `await` - осознанное fail-closed свойство, и это стоит записать в DEVLOG.

### F3 (minor) - пробелы в тестах `crm-audit-agent-service-role-targets.postgres-spec.ts`

Стенд использует настоящие `WorkspaceMigrationRunnerService` и обработчики действий под ограниченной ролью БД. Билдер же написан вручную: нет валидаторов, движка побочных эффектов и `enrich`. Я сверил по коду, что реальный порядок (`compute-ordered-migration-actions.util.ts:61-68`) и сохранение `id` (`workspace-migration-flat-entity-maps.service.ts:137-151`, `enrich-create-workspace-migration-action-with-ids.util.ts:227-231`) дают те же формы действий. Порядок `agent.create`/`agent.update` в фейковом билдере обратный реальному, но эти действия вместе не встречаются. Недостающие случаи:
1. `deleteManyAgents`/`deleteOneAgent` для агента **с** ролью без identity и с неаудируемой identity: ожидается отказ, агент, привязка и аудит без изменений. Это единственный путь, где проверка идёт после `await`, и он заявлен в `test-research.md` §1.4.
2. Регрессия на F1: кэш без роли, вставка R до runner.
3. `canBeAssignedToAgents=false` (`:1119-1136`) в проде отсекается билдером (`validateFlatRoleTargetAssignationAvailability`), так что тест проверяет только эшелонированную защиту аудита. Update-путь с такой ролью не покрыт.
4. Заголовок «before the first await» (`:1078`) ничем не подтверждён. Стоит проверить, что `cache.getOrRecompute` и `findWorkspaceTwentyStandardAndCustomApplicationOrThrow` не вызывались.
5. Resolver покрыт только для create; передача identity в update/delete не проверена. Замена роли (delete+create) у агента чужого приложения не покрыта.

### F4 (minor) - замена роли меняет владельца привязки

- **Где:** `from-update-agent-input-to-flat-agent-to-update.util.ts:69-90`.
- **Сценарий.** Раньше `update` сохранял `id`, `universalIdentifier` и `applicationId` привязки. Теперь создаётся новая строка со случайным UID и `applicationId` приложения миграции. При этом в плане указан `applicationUniversalIdentifier` агента, и сохранённое расходится с запланированным. Аудит это допускает: он сравнивает цель с агентом, а не с приложением миграции, как общая ветка `:1716`. Поведение совпадает с каноническим `RoleTargetService.createMany` (`from-create-role-target-input-to-flat-role-target-to-create.util.ts:50-77`). Однако для агентов приложений с ролью из манифеста (детерминированный UID) стоит проверить повторную синхронизацию: возможен конфликт с `IDX_ROLE_TARGET_UNIQUE_AGENT`.
- **Исправление.** Планировать новую привязку под приложение миграции, как в `RoleTargetService`, и в ветках create/update сравнивать `targetInput.applicationUniversalIdentifier` с приложением миграции. Отдельно проверить ресинк манифеста.

### Мелочи (nit)

- `agent.service.ts:436`: `roleTarget.agentId as string` - лучше строить пары из `agentsToDelete`. Сейчас это и так fail-closed через `uuid()`.
- `role-assignment-audit.ts:1001`: delete-ветка - неявный «остаток» после create/update. Явная проверка `request.agentMode === 'delete'` была бы надёжнее.
- В spec есть нумерованные комментарии с пересказом того, что делает код (`:896`, `:918`, `:933`, `:974`, `:1052`, `:1201`); правила дома требуют комментировать только WHY.

## Проверка реального пути

Путь `AgentService` → `withAgentMetadataRoleTargetAudit` → `validateBuildAndRunWorkspaceMigration` → `WorkspaceMigrationRunnerService.executeRun` (`getRoleAssignmentAudit`, `:391-401`) → `runAuditedRoleAssignment` → обработчики подтверждён по коду. Сборщик и валидаторы в тестах подменены; соответствие форм действий проверено вручную (F3). Работа в живом окружении не проверялась.

## Что исправлено после ревью

- **F1.** `deleteManyAgents` при любом непустом `ids` идёт через аудируемую delete-ветку и требует аудируемую identity до первого `await`. Delete-ветка допускает пустой `targets`, блокирует удаляемых агентов `FOR UPDATE` (конфликтует с `KEY SHARE` при вставке `roleTarget`) и сверяет, что привязок в БД ровно столько, сколько в плане. Неаудируемого пути удаления агента больше нет; `DeleteAgentTool` без `authContext` теперь отклоняется, как и инструменты ролей. Регрессия: «rejects deleting an agent whose role binding is missing from the cache instead of cascading it unaudited».
- **F2.** Комментарий в `agent.service.ts` описывает фактическое правило: identity требуется для любого `roleId` во входе и для любого удаления. Ранний отказ до первого `await` записан в DEVLOG как осознанное fail-closed свойство.
- **F3.** Добавлены случаи: удаление без identity и с `pendingActivationUser` отклоняется; регрессия F1; `cache.getOrRecompute` не вызывается после ранних отказов; update-путь с неназначаемой ролью откатывается; resolver update/delete передают identity; замена роли у агента чужого приложения.
- **F4.** Новая привязка при смене роли планируется под приложением миграции (`roleTargetApplication`), а update-ветка аудита сверяет `applicationUniversalIdentifier` плана с приложением миграции. Ресинк манифеста после замены роли у агента приложения может упереться в `IDX_ROLE_TARGET_UNIQUE_AGENT`, как и после `AiAgentRoleService.assignRoleToAgent`; перенесено в [следующий участок](next-boundary.md).
- **Мелочи.** Пары `targets` строятся из `agentsToDelete`, delete-ветка явно проверяет `agentMode`, пересказывающие комментарии в spec удалены.
- **Guard Enterprise.** Импорт типа `FlatApplication` в утилиту обновления агента добавлял ребро к `flat-application.type.ts`, которое транзитивно ведёт к Enterprise. Параметр заменён на `Pick<FlatRoleTarget, 'applicationId' | 'applicationUniversalIdentifier'>`, `--verify-baseline` проходит.
