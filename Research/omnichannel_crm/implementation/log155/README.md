# LOG155 - транзакционная проверка свежести import policy и blocklist при сохранении сообщений и календаря

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG155 закрывает гонку между внешней выборкой/предварительной фильтрацией и транзакцией сохранения для импорта сообщений (`MessagingSaveMessagesAndEnqueueContactCreationService.saveOrdinaryMessageBatchWithAudit`, `InboundEmailImportService.importInboundMessage`), сохранения событий календаря (`CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`) и очистки связей синхронизации календаря (`deleteOrdinarySyncCalendarAssociationsWithAudit`).

В `import-policy-proof.ts` добавлены `captureLockedBlocklistPolicyProof` и `captureLockedMessageImportPolicyProof` без рёбер в Enterprise-граф: таблицы `blocklist` и `workspaceMember` блокируются `IN SHARE MODE`, проверяется внешний ключ `blocklist."workspaceMemberId" -> workspaceMember.id`, захватываются `FOR SHARE` снимки `blocklist`, `workspaceMember` и `core."userWorkspace"`, вычисляются применимые правила `WORKSPACE` и правила участника для `userWorkspaceId` (с отказом при неоднозначном активном членстве), а также проекции политики `core.workspace`, `core."connectedAccount"` и `core."messageChannel"` через `to_jsonb`.

В `saveOrdinaryMessageBatchWithAudit` значения `handle`, `handleAliases`, `isContactAutoCreationEnabled`, `contactAutoCreationPolicy`, `excludeNonProfessionalEmails` и `excludeGroupEmails` обновляются из заблокированных строк БД и возвращаются вызывающему методу для постановки `CreateCompanyAndContactJob`; пачки сообщений проверяются под транзакционными блокировками на `.ics`, `unsubscribe`, `blocklist`, `excludeGroupEmails`, `isInternalMessagesImportEnabled === false` (`provider`) и `isUpstreamSpam` / `excludeGroupEmails` (`inbound`), отклоняясь до любых native-записей. В `InboundEmailImportService.importInboundMessage` при отклонении сохранения под актуальной политикой (`undefined`) внешний источник очищается и возвращается `{ kind: 'excluded' }`.

В `CalendarSaveEventsService` (при наличии `expectedRun`) и `deleteOrdinarySyncCalendarAssociationsWithAudit` захватывается `captureLockedBlocklistPolicyProof`, события повторно проверяются через `filterEventsAndReturnEventsToRemove` с актуальными `channelHandles`, `applicableBlocklistHandles` и `excludePrivateEvents` до любых записей, а неизменность политики и `blocklist` повторно проверяется перед `audit.flush()` и после `SET CONSTRAINTS ALL IMMEDIATE`.

3018 tests/100 suites PASS (668.834s). 170 targeted/6 suites PASS (84.991s), 4 новых PostgreSQL и 1 unit случай. 26 guard tests PASS, 10 migration checksums неизменны. Types 449/451 roots, baseline 220 / current 220 diagnostics, 0 новых/changed-file. Совпали 7 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [аудит удаления ролей и назначения ролей агентам и API-ключам](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
