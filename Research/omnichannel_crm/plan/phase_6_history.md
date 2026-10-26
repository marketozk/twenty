# Этап 6. Вложения, изменения сообщений и импорт

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Зависимости: 1, 2a, 3, 4; финальный suppression test с 5. Статус: не выполнен.

**Существующие:** Twenty `ApplicationMessageIngestionService` (сейчас attachments:[]), DTO `engine/metadata-modules/message-channel/dtos/ingest-app-messages.input.ts`, file upload/storage/download; connector `bridge/{archive.py,media.py,partner_api.py}` и Telegram/MAX native history из research.

**Новые:** `modules/omnichannel/{attachments/,imports/,jobs/import-batch.job.ts}`, front import progress/missing-file states, migration для AttachmentLink/ImportBatch при отсутствии из этапа 1. Public APP input меняется только совместимым optional extension; существующие email/app callers сохраняют поведение.

1. Capability matrix text/photo/document/voice/video/reply/edit/delete/read receipt для каждой версии адаптера. Неподдержанное — явный результат, не молчаливый drop. Форматы/размеры согласовать с реальными ограничениями.
2. File ingestion: защищённая загрузка, hash, размер/тип/SSRF limits, ACL выдачи; credential/token links не логировать. Недоступное старое вложение остаётся missing marker.
3. Edit/delete ordering, связь по stable native identity, audit; обновление поиска и AI context. Без provider revision использовать reconciliation, не timestamp поступления как истину.
4. Import source adapters SaleBot/connector journal/native history -> общий ingest с trusted origin=import. Checkpoints, bounded batches, watermark, overlap с live, повтор после crash; ноль новых бизнес-действий.
5. Сверка количества/диапазона/attachment gaps/participants, отчёт completed_with_gaps. Retention источника 30 дней по умолчанию и ограничения выгрузки не выдаются за полноту истории — читать фактические настройки и доступные данные перед импортом.
6. Зафиксировать RouteActivation boundary до включения automation; проверить import→live, live→import и параллельный порядок для одного Message до/после границы. До границы — ноль эффектов; после границы импорт сам ничего не запускает, доверенный live/replay допускается ровно один раз через AutomationAdmission независимо от первого insert. Без доказуемой позиции — reconciliation, не угадывание. Сохранить replay новых событий при overlap.

**Verify:** повтор/прерывание/overlap даёт одну историю с исходными датами; несовпадение payload обнаружено; старое сообщение не вызывает send/AI/workflow/уведомление; ACL файла после revoke; media failure не теряет текст и не создаёт ложный sent. Отдельный security test arbitrary file URL.

**Done when:** доказан возобновляемый импорт доступной синтетической истории обоих каналов с честной сверкой; реальные источники/период/retention выбраны до клиентского запуска.

**Rollback:** pause batch и workers, сохранить cursor/receipts/files. Не удалять весь channel: его удаление может удалить историю. Очистка импортированных записей отдельным согласованным планом по batch ID.
