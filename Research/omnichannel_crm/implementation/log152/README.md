# LOG152 - аудит автоматического создания компаний и контактов

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG152 переводит автоматическое создание компаний и контактов (`CreateCompanyAndContactJob`, `CreateCompanyAndPersonService`, `CreateCompanyService`, `CreatePersonService`) для источников `EMAIL` и `CALENDAR` на двухфазный закрытый owner с единым аудитом в одной strict/exclusive транзакции на каждую пачку до 100 контактов (`CONTACTS_CREATION_BATCH_SIZE`).

На первой фазе вне блокировок БД `CreateCompanyService.prefetchCompanyInfoByDomainNames` нормализует рабочие домены и запрашивает внешние метаданные (`name`, `city`) только для доменов, отсутствующих в `company`. На второй фазе внутри `runInWorkspaceTransaction` (`{ commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' }`) блокируются и проверяются `core.workspace`, `core.connectedAccount`, `core.userWorkspace` (с привязкой к `workspaceId`), `core.user` и флаги `isContactAutoCreationEnabled` каналов `core.messageChannel` / `core.calendarChannel`, а также отсутствие привязки к omnichannel (`findOmniOwnedConnectedAccountIds`, `findOmniOwnedMessageChannelIds`).

Таблицы `company` и `person` блокируются в режиме `SHARE ROW EXCLUSIVE`, `workspaceMember` — в `SHARE`. Повторное восстановление уже живых компаний исключено (`deletedAt !== null`), цели восстановления `company` и `person` дедуплицируются по `id`, проверяются полный ожидаемый образ PostgreSQL через `castCalendarProofImage`, точное совпадение `RETURNING` (`contactCreationActualIds`), каскадные внешние ключи при обновлении (`assertNoReferentialUpdateEffects`) и отложенные ограничения (`SET CONSTRAINTS ALL IMMEDIATE`). Неопределённые исходы (`NativeTransactionOutcomeUnknownError`, `CoreAuditPostCommitError`) пробрасываются без перехвата и останавливают последующие пачки.

2994 tests/97 suites PASS (636.398s). 817 targeted/19 suites PASS (232.996s), 17 новых PostgreSQL и 4 unit случая. 26 guard tests PASS, 10 migration checksums неизменны. Types 445/448 roots, baseline 225 / current 219 diagnostics, 0 новых/changed-file. Совпали 7 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Начальная настройка моков ESM-цепочки `SecureHttpClientService`, имя репозитория `'company'` в тестовом `WorkspaceDataSource` и четыре первичные ошибки типов устранены и сохранены в initial/second логах.

Далее - [долговечное сохранение и восстановление манифеста сопоставления календаря](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
