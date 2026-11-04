# LOG150 - аудит первоначального сохранения обычных сообщений

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG150 переводит первоначальное сохранение обычных сообщений в `MessagingSaveMessagesAndEnqueueContactCreationService` на закрытый owner с единым аудитом для пяти таблиц записи (`messageThread`, `message`, `messageChannelMessageAssociation`, `messageParticipant`, `messageChannelMessageAssociationMessageFolder`) и неизменным чтением `messageThreadTarget` в одной strict/exclusive транзакции.

Из `MessagingMessageService`, `MessagingMessageParticipantService` и `MessagingMessageFolderAssociationService` выделены read-only методы планирования (`prepareMessageSaveWithinTransaction`, `prepareMessageParticipantsWithinTransaction`, `prepareMessageFolderAssociationsWithinTransaction`). Канонические пути приёма и отправки omnichannel продолжают использовать существующие `saveMessagesWithinTransaction` и `saveMessageParticipants` без вложенных транзакций и дублирования аудита.

Перед первой записью захватываются и проверяются полномочия источника (`provider`, `inbound`, `sent`, `sent-tool`, `application`), папки `core.messageFolder` и ссылки на `person` / `workspaceMember`, а также устанавливаются табличные блокировки `SHARE ROW EXCLUSIVE` на пять таблиц записи и `SHARE` на `messageThreadTarget`. Проверяются полный ожидаемый образ PostgreSQL, фактический `RETURNING`, каскадные внешние ключи при обновлении, пропущенные или переписанные триггерами строки и отложенные ограничения (`SET CONSTRAINTS ALL IMMEDIATE`). Выходные карты и манифест затронутых участников строятся только по реально подтверждённым строкам.

2956 tests/94 suites PASS (605.022s). 669 targeted/14 suites PASS (164.12s), 30 новых PostgreSQL случаев в `crm-audit-ordinary-message-save.postgres-spec.ts`. 26 guard tests PASS, 10 migration checksums неизменны. Types 439/442 roots, baseline/current 225 diagnostics, 0 новых/changed-file. Совпали 10 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Начальные падения тестовых триггеров/прав в новой PostgreSQL спецификации и четыре первичные ошибки типов устранены и сохранены в initial/second логах.

Далее - [долговечное сохранение и восстановление манифеста сопоставления](next-boundary.md). Создание контактов, общий HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
