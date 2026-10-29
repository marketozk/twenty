# LOG136 — проверка границ очистки

Подключены MessagingMessageCleanerService, MessagingMessageListFetchService,
MessagingDeleteGroupEmailMessagesService, MessagingDeleteFolderMessagesService,
MessagingDraftSendService, SendEmailService и SendEmailResolver. Внешние DTO
отправки сохранены; внутренний draft result несёт точный cleanupTarget.

## Исправления при разработке

- После provider await нельзя заново выбирать первую подходящую association:
  исходная могла отличаться от выбранной теперь. Перед вызовом провайдера
  захватываются associationId/channelId/externalId, затем проверяются именно они.
- Folder discovery без блокировки мог выбрать строку, уже перемещённую в другую
  папку к моменту snapshot. Проверка диапазона теперь выполняется после захвата
  родителей и дочерних строк, до первой mutation; внешний перенос остаётся,
  собственные изменения и аудит откатываются.
- Перед очередной стадией проверяются предыдущие snapshots. Actual-effect masks
  не должны скрывать изменение исходной строки последующим cascade.
- Group count использует фактически удалённые primary associations, а не длину
  запроса или дополнительные orphan/thread effects.
- NULL externalId в папке сохраняет parent и допускает только junction cleanup;
  empty string остаётся допустимым идентификатором согласно прежнему контракту.
- List fetch пробрасывает unsafe transaction outcome до generic error handler.
  Post-send cleanup и даже отказ logger не отменяют подтверждённый provider result.
- Консервативный dependency guard выявил type-only путь через ConnectedAccountEntity.
  ConnectedAccountScope выделен в leaf type с обратным re-export; helper сохраняет
  исходную политику WORKSPACE или owner без зависимости от entity graph.
  Baseline Enterprise не расширялся.
- Четыре падения старых lower-owner тестов объяснялись тестовой папкой: добавленная
  настоящая core metadata сделала общую папку защищённой из-за omni-переписки.
  Обычное письмо получает отдельную папку до snapshots; проверки удаления и отката
  сохранены. Верхние mixed-folder сценарии по-прежнему требуют отказа без изменений.

## Проверки и границы

Проверки PostgreSQL используют реальные owners, блокировки, триггеры,
откат, deferred changes и потерю COMMIT acknowledgement. Тесты entrypoints
проверяют request attribution и точную передачу отправленного draft target.
Прежние group/folder/sync тесты адаптированы к новым сигнатурам и общей транзакции.
Независимый проход по текущим production callsites, транзакциям и post-send
обработке новых подтверждённых блокеров не обнаружил; это чтение кода, не запуск тестов.
Нижняя per-record защита и более строгий admission рабочих задач проверяются
отдельно; успешное удаление защищённого account не допускается ради старого теста.

Это не доказательство полной provider idempotency, защиты всей отправки от
in-flight отзыва доступа, защиты от произвольного raw SQL writer или полного
аудита native CRM. Последний собранный кандидат остаётся LOG088.

Прежние upstream resolver/policy tests дополнительно запускались с upstream
настройками трансформации ESM и setupTests. Изолированной среде потребовался
абсолютный путь к Lingui SWC plugin; рабочий config в репозитории не менялся.
После настройки запуска прошли 9 тестов в двух наборах.
