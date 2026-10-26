# Авторская проверка R15

Автор знает историю и не является вторым слепым reviewer. Fresh A Claude получил39 технических документов и pinned исходники без прошлых findings/реестра. Ниже — авторская проверка исходников и исправлений, не доказательство runtime.

## Фактические источники

- `packages/twenty-server/src/engine/core-modules/workflow/controllers/workflow-trigger.controller.ts`: public GET/POST проверяет workspace/version/ACTIVE и запускает runner, но не аутентифицирует внешний webhook. Поэтому у governed ingress собственный signed POST и captured credential lineage; legacy path закрывается для protected workflow.
- `packages/twenty-server/src/modules/match-participant/jobs/reconcile-person-company-targets.job.ts` и `participant-target-reconciliation.service.ts` (включая reconcileTargetsForPeople): выборка участников и derived Person/Company/Opportunity targets не делает native reconciler проектором explicit ConversationTarget. Для omni нужен persisted exclusion до mixed batches и собственный canonical projector.
- `packages/twenty-server/src/modules/workflow/workflow-trigger/automated-trigger/crons/jobs/workflow-cron-trigger-cron.job.ts`, handle/getAndRunTriggersFromCache/getAndRunTriggersFromDatabase: dispatch основан на now/cache/scan. Собственный durable schedule cursor/gap должен добавляться, существование уже готового replay не заявляется.
- 49 выбранных source files сверены по хэшам с рабочей копией и по LF-normalized bytes с pinned729f6236126eddaa68d176fb766bc349b19de11d. Это проверка идентичности, не утверждение, что каждый source body заново прочитан автором.

## Проверка связей плана

Нормативные definitions исправлены в schema и owners. Phase/API/source-map ссылки синхронизированы. Исторические raw findings сохранены. Self-review выявил composite FK unique target, captured webhook credential refs, CRON policy lock mode и ошибочное размещение audit flush в фазе2b вместо2a. Все проявления внесены в registry, включая порождённые правками.

Каналы риска: webhook admission/revoke → явный credential lifecycle и будущие T25-F; ingress/queue/access → atomic config и T10/T12/T13; cron/cursor/concurrency → gap-before-advance и T14-E/T19; audit/transactions → same-executor flush/rollback и T06; assignment/read-cursor → разные authority stores и T12. Контрпримеры проверяются на согласованность текста Claude B/targeted; SQL correctness и race behavior пока не доказаны.

## Ограничения

Абстрактная модель (1712 случаев/23 negative controls) не покрывает новые webhook, queue bootstrap, read-cursor или audit transaction contracts. Не запускались SQL/transport/UI/integration tests, сборка, деплой и изменения runtime. Внешние userbot repositories/живая конфигурация в пакет не входили. Продуктовые gates остаются решениями владельца, не принятыми автором рисками. Итоговый статус — review-result.md, а не этот self-review.
