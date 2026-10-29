# LOG137 — проверка blocklist boundary

Исследованы actual job/listener, groupBlocklistHandlesByOwner,
BLOCKLISTED_PARTICIPANT_ROLES и закрытые стадии native-message-cleanup-with-audit.
Прежний прямой association DELETE выполнялся до отдельного orphan sweep;
его изменения не входили в аудит sweep.

## Реализация

- Snapshot всех запрошенных правил, включая tombstones, native workspaceMember,
  core membership, account custodian/aliases и channel handle/parent.
- Member scope действует только на текущего владельца аккаунта; WORKSPACE sharing
  самого аккаунта не расширяет персональное правило на другого владельца.
- Sources блокируются до mutation и проверяются после flush/deferred drain.
  Исходные участники, включая исключённых, проверяются вместе с диапазоном родителей.
- Точные candidate IDs не заменяются external IDs. Общий externalId двух разных
  сообщений не удаляет исключённое сообщение; мягко удалённые participants и
  associations не отбираются. Message.deletedAt не меняет исходную политику job.
- Shared private stages используют фактические RETURNING/FK effects; late source
  mutation не скрывается последующими cascade masks.
- Нет catch/fallback в job: unsafe outcome сохраняет исходный error instance и
  останавливает следующие страницы/правила/каналы и финальный sweep.

## Проверки и исправления

Независимый проход по owner сверил SQL parity, текущего custodian, lock/readback
и начальный отказ для bound/reserved channel; новых подтверждённых дефектов не найдено.
PostgreSQL tests проверяют оба порядка настоящей блокировки rule UPDATE,
потерю COMMIT acknowledgement, actual skip, audit failure, позднее изменение
policy/alias/participants и сохранность защищённого графа.

Первый typecheck нашёл шесть диагностик только в трёх вызовах тестового remove:
wrapper допускал синхронный результат или Promise. Помощник явно объявлен async;
проверки отказов и настоящих гонок сохранены. Список FROM/TO берётся из
существующей BLOCKLISTED_PARTICIPANT_ROLES, а не из новой копии.
Её runtime значения сохранены, но зависимость от общего types barrel удалена:
консервативный guard находил через него Enterprise path. Проверены все callsites;
единственный оставшийся потребитель константы — новый SQL owner.
Общая регрессия была запущена до этой последней правки зависимости. Значения
константы не изменены; окончательные целевые тесты и typecheck выполнены после
правки и относятся к сохранённым source hashes.

Нельзя считать этот результат доказательством whole-mailbox snapshot,
durable event delivery, queue/crash exactly-once или полной HTTP/JWT приёмки.
Calendar blocklist имеет другой существующий контракт и здесь не изменяется.
