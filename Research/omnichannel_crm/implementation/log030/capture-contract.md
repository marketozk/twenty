# LOG-030: контракт доверенного контекста захвата

Следующая внутренняя граница перед Message apply. Эта порция добавляет только
закрытую schema, snapshot/hash и unit-проверки. Ingress, миграции и runtime
callers этим документом не объявляются изменёнными.

## Основание в действующем плане

- [Spec §4](../../plan/implementation-spec.md#4-приём-и-отправка--rob-764):
  внешний payload не назначает origin/actor/person; receipt сохраняет исходное событие.
- [Spec §15.2](../../plan/implementation-spec.md#152-идентичность-источника-контакта-и-внешнего-автора):
  canonical native key определяется квалифицированным адаптером; raw ID, направление
  и placeholder не разрешают догадку об идентичности.
- [Spec §15.10](../../plan/implementation-spec.md#1510-исполнимые-точки-интеграции-workflows-и-messaging-helpers):
  native header строится из binding/chat/version/canonical key; повтор не создаёт
  новый admission, completeness и trusted order проверяются отдельно.
- [Spec §15.16](../../plan/implementation-spec.md#1516-pull-истории-и-единый-transport-schema):
  history_import назначает внутренний import job с текущим разрешением.
- [Wire schema](../../../../packages/twenty-server/src/modules/omnichannel/contracts/README.md):
  sourcePosition остаётся opaque; реальные адаптеры пока не квалифицированы.

## Новый внутренний контракт

`snapshotOmniIncomingCaptureContext(input, envelopeInput)` синхронно валидирует
envelope и отдельный capture context, возвращает detached/frozen `context`,
его `canonicalJson` и SHA-256 `hash`. Никаких async callbacks или сохранения здесь нет.

Контекст версии 1 содержит:

- `envelopeHash` — существующий canonical hash всего parsed envelope. Он связывает
  контекст с eventId/binding/generation/chat/raw message ID/direction/body; эти поля
  не дублируются второй копией внутри контекста.
- `origin` — live, history_import либо restore_replay. Это значение выбирает
  доверенная серверная граница, а не connector JSON или worker при replay.
- `qualification.adapterId/adapterVersion` — стабильная ссылка на конкретную
  квалификацию mapping, completeness и сравнения source positions.
- `nativeMessageKeyVersion/nativeMessageKey` — уже квалифицированный versioned
  canonical key. Функция не строит его из raw ID и не склеивает направления.
- `sourceVariant/sourcePosition` — значения, которые квалификация подтверждает
  для данного envelope; они должны точно совпадать с parsed wire значениями.
  Nullable position остаётся неизвестной, не превращается в порядковое число.

Все объекты закрыты; actor, Person, grants, source credentials, verified flags
и неизвестные metadata запрещены. Строковые ключи используют ограничения wire
identifier; числа провайдера не преобразуются в JS number. Object key order не
влияет на hash; изменение origin, qualification или canonical key влияет.

## Граница доверия

Успешная schema validation не доказывает квалификацию и не выдаёт право на import,
live automation или доступ к клиенту. Даже корректно вычисленный envelopeHash
не является подписью. Реальный ingress обязан отдельно получить origin от
доверенного server caller и проверить qualification в серверном registry для
текущего binding/platform/version; wire caller не может подавать этот аргумент.
Для history остаётся обязательной текущая import/history.read авторизация,
для restore — соответствующий authenticated reconciliation path.

Qualified null position не разрешает admission: eligibility, activation boundary
и сравнение opaque positions выполняет отдельный qualified adapter/domain writer.
Здесь нет comparator, реальной Telegram/MAX qualification, провайдерских запросов
или автоматически включённой automation. Синтетические fixtures не подтверждают
совместимость рабочих коннекторов.

## Реализованная граница ingress/schema

Context и hash сохраняются вместе с receipt и audit через тот же executor.
Ingress API сохраняет прежние четыре аргумента и добавляет отдельный
optional пятый `trustedCapture: { context, authorize }`. При наличии context
обязательный server authorizer проверяет origin и registry qualification под
теми же policy/binding locks, в том числе при replay. Старый четырёхаргументный
вызов сохраняет NULL/unqualified, не назначает молча live и не разрешает apply.
Wire hash остаётся прежним; replay сравнивает также capture hash. Изменённый
origin/key/qualification с тем же eventId не перезаписывает принятый контекст.
Старый NULL context означает отсутствие сохранённой квалификации, а не implicit
live/import. Добавлены пятая fork migration, prefix-aware schema verification
и PG rollback/lost-ACK/conflict тесты. Старые migration sources не менялись.

Capture contract пока не подключён к apply и не означает готовность его writer.
Unit tests проверяют shape/hash/snapshot/crosschecks; PostgreSQL tests отдельно
проверяют вызов синтетического authorizer, locks и атомарность. Реальный registry
коннекторов и текущие import permissions ещё не реализованы. Immutability здесь —
контракт domain writer и ORM update:false; raw SQL UPDATE не блокируется отдельным
DB-триггером. CHECK проверяет пару NULL/object и формат хеша, не всю JSON-schema.
