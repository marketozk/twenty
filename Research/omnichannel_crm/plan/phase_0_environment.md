# Этап 0. Среда и проверка технических границ

Статус: не выполнен. Цель — снять неизвестные до широкого изменения ядра.

## Файлы

Существующие: `packages/twenty-docker/twenty/Dockerfile`, `package.json`, `yarn.lock`, `.yarnrc.yml`, server/front/shared `project.json`; server `engine/twenty-orm/workspace-orm.manager.ts`, `engine/twenty-orm/types/workspace-transaction-scope.type.ts`, `engine/api/common/common-query-runners/common-base-query-runner.service.ts`, messaging `messaging-save-messages-and-enqueue-contact-creation.service.ts`, `messaging-message.service.ts`.

Новые: `Research/omnichannel_crm/implementation/{environment.md,integration-map.md,license-inventory.md}`, `ops/omnichannel-demo/compose.yaml`, `.env.example` без секретов. Последние создаются после inventory портов/ресурсов; не переносить актуальные секреты в пример.

## Задачи и проверки

1. Linux build runtime, Node/Yarn по проекту, immutable install, сборка shared/server/front. Использовать Dockerfile snapshot (Node24), а не локальный Node22. Проверить ресурсную ёмкость до сборки на общем сервере. Сохранить версии, команды и полный build SHA.
2. Отдельные PG/Redis/storage и тестовый workspace. Проверить migrations/upgrade status и UI на синтетике; демо 2.51 не использовать для reset. Проиграть restore тестового backup.
3. Transaction spike: в одной workspace transaction сохранить Message + тестовую служебную запись + audit; искусственный exception откатывает всё. Описать metadata/migration registration и автоматические API новых таблиц. Если общая транзакция невозможна выбранным способом, изменить ADR до дальнейших изменений.
4. Карта entry points: REST/GraphQL, прямой WorkspaceOrmManager, subscriptions/search/export, files, AI, workflow, core metadata mutations, auth. Для каждого указать call site, владельца транзакции, проверку scope и точку аудита. Не считать CommonBaseQueryRunner единственным путём.
5. Проверить лицензии файлов/зависимостей. Сохранить `license-inventory.md`: исходный проект/SHA, файл или зависимость, лицензия, основание и способ переиспользования. Отдельно перечислить Enterprise-пути и разрешённые точки расширения; не копировать их реализацию в свой модуль. Обновлять перечень по мере реализации и сверить при финальной приёмке.
6. Проверочный concurrency spike: epoch/policy check, CRM tool mutation и audit разделяют transaction fence с takeover/revoke. Принудительно остановить tool после проверки, выполнить конкурирующий takeover и доказать сериализуемый результат; generic tool path включён. Если transaction owners не позволяют это сделать, пересмотреть ADR до этапа 5.

**Verify:** успешные реальные команды build/test в отчёте, rollback spike PostgreSQL, карта всех entry points с точными файлами. На этом этапе допустим fake connector, реальные send не нужны.

**Done when:** воспроизводимая сборка; одна транзакция доказана; найдено место для собственной политики и transactional audit на каждом write path. После исследования обновить file-level планы 1–3: неподтверждённый hook нельзя заменить предположением.

**Rollback:** удалить только созданный тестовый стек после идентификации ресурсов; приложение/демо/рабочие базы не менялись. Тестовые исходники остаются в Git.
