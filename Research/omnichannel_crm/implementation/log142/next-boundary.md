# Далее — сохранение событий календаря от провайдера

CalendarSaveEventsService имеет два production входа: import с expectedRun и
persistCalendarEvent после успешного внешнего создания без sync run. Существующий
scope уже объединяет Event insert/update, Association insert/update и Participant
delete/update/insert. Upsert здесь нет; существующие pure planners сохраняются.

Следующий closed owner должен подключить этот трёхобъектный graph к одному audit
context в strict/exclusive native transaction, возвращая фактически сохранённые
IDs. Не включать все system objects в generic audit и не придумывать sync run
для ручного создания. Захватывать nested event input и trusted actor до await,
а для внешнего создания — до provider call.

Owner остаётся в существующем CalendarSaveEventsService: его planner imports
уже существуют. Новый terminal module с теми же imports добавил бы запрещённые
связи с EE через общие barrels. Три participant write loops переносятся в эту
же закрытую транзакцию, чтобы проверять RETURNING и граф между стадиями;
discovery/matching остаются в ParticipantService. Новые helpers — только pure
structural utilities без callbacks, reusable sessions и внешних finalizers.
Существующие transient-DB tests сохраняют rollback assertions с новым местом
fault injection. Dependency guard должен пройти без изменения baseline.

Sharing использует текущие handles/aliases, provider и состояние других каналов:
нужны согласованный account-before-channel lock order и повторные проверки.
Не принимать изменённые триггером данные за новый before-image. Actual RETURNING
определяет diff и последующие participant IDs. Сохранять существующие Google /
Microsoft sharing и live-only discovery semantics.

Matching/Targets/автосоздание контактов выполняются после save и остаются отдельной
работой. Ошибка после сохранения не должна выглядеть rollback; после внешнего
provider success сбой persistence или logging не должен провоцировать повтор
внешнего создания. Требуются реальные PG failure/race/ACK проверки и entry tests
с явной provider подстановкой без отправки клиентских сообщений.
