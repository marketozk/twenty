# LOG141 — аудируемая очистка при синхронизации календаря

Удаление связей по provider external IDs и последующих orphan Event использует
один closed owner и один audit context. Проверяются текущий expectedRun,
исходный граф пяти таблиц, фактические удаления и сохранность CallRecording.
Оба consumer импорта и реальный cleaner подключены к этому owner.

Раннее изменение канала/external ID безопасно пропускается; после фиксации
снимка изменения вызывают откат. Matching tombstones учитываются ровно один
раз при фактическом каскаде. Прежние условия отбора provider events сохранены.

Ошибки неизвестного или уже подтверждённого COMMIT передаются без изменения
до logging/error-handler/status mutations, чтобы не допустить обычный retry.

- [Результаты](results.json), [исходники](source-snapshot.json), [типы](typecheck-differential.json).
- [Итоговые целевые проверки](target-final.log), [регрессия](regression.log), [guards](guards.log).
- [Первый целевой проход](target.log), [upstream filter](upstream-units.log).
- [Ревью и ограничения](review.md), [следующая работа](next-boundary.md).

Предшествующие cache pop/provider saves остаются вне cleanup транзакции.
Актуальность ранее прочитанной import policy этим аудитом не доказывается.
ROB765 In Progress; полный provider save audit, сборка, выкат и HTTP/JWT приёмка
не выполнены. GitHub Actions не используется.
