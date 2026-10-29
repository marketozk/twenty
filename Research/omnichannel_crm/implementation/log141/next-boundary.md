# Далее — публичные настройки календарного канала

Следующий ограниченный production путь: updateCalendarChannel, включая его
условный сброс синхронизации при изменении excludePrivateEvents. Настройки и
сброс должны иметь единый core owner, проверку текущего владельца и общий аудит.
Очистка текущего account-scoped cache key выполняется только после confirmed commit;
её отказ не должен превращать состоявшееся изменение в retry-safe ошибку.

Сохранить owner-only политику настроек, отдельный ordinary gate только для reset
и прежний DTO, полученный до reset. Не переносить gate reset на все изменения
настроек. При неизвестном исходе COMMIT не продолжать последующие действия.

Generic native audit не покрывает calendar system objects автоматически.
Provider save — отдельный дальнейший участок: реальны два caller, import с
expectedRun и сохранение уже созданного внешнего события без run. Event,
Association и Participant пишутся вместе, matching/Target/contact stages —
после этого. Они не становятся аудируемыми от подключения cleanup.

Core OAuth creation/reconnect, sync lifecycle, participant matching/target
projection и system contact creation остаются в реестре открытого покрытия.
