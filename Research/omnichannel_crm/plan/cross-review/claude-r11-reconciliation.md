# Сверка R11-B по манифесту `review-r11-b-manifest.json`

**Вердикт по ограниченному объекту: `bounded_tables_ready`.** Конкретных противоречий в сверяемой delta не осталось. Все пять ID получают `closed_in_plan` в пределах проявлений R11.

Остальные 48 исторических ID я заново не проверял. Готовность всего проекта (`ready_for_implementation`) из этого не следует.

## Что прочитано

- `decision-tables.md` целиком, `check_decisions.py` целиком, счётчики и мутанты в `model-result.json`.
- `registry.md`: строки с ID и раздел R11 (226–242).
- Изменённые абзацы: `06-api.md:56`, `:77`, `:81`; `09:134`; spec `:48`, `:82-87`, `:283`, `:505-507`.
- **Модель я не запускал** (shell запрещён), сверил вручную по коду. Получилось 6+7+1536+120+43=1712. Ручной пересчёт пойманных мутантов совпал по всем 12 проверенным контролям, в том числе `ignore_closed`=39, `human_requires_captured_scope`=16, `ignore_dispatch_cancellation`=7, `silent_conflicting_proof`=8, `accepted_not_outstanding`=17.

## Вердикт по ID

| ID | Статус | Основание |
|---|---|---|
| N-10 | closed_in_plan | `setMode(auto)` блокируется при accepted и при cancelRequested: таблица `:86`, `06:77`, `can_set_auto` на наборах из 0–2 команд. Мутанты `accepted_not_outstanding` и `cancel_request_unblocks_auto` пойманы |
| N-23 | closed_in_plan | Close и cancel разведены: локальная pending против удалённого cancelRequested, только выигравший tombstone даёт cancelled (P06, C09–C11). Противоречащий ACK после cancelled/failed даёт reconcile (`:90`, модель `:97`) |
| M-7 | closed_in_plan (в пределах R11) | Канонический core ID, sticky coverage, `cancellationEpoch`. Деактивация теперь доходит до уже созданной Command: строки `:37`, P13, C03, `09:134`, spec `:48`, `:507`. Добавлены E15 (crash после commit), O→G с видимым empty или gap, filter-miss фиксируется при admission |
| M-2 | closed_in_plan | `cancelCommand` есть в минимальном списке (`06:56`) и в семантике endpoint (`06:81`): idempotent, tombstone, cancelled/too_late подтверждает только journal. Spec `:283` согласован с ними |
| N-15 | closed_in_plan | ResourceScope и workflowCancellationRefs требуются только от non-human (таблица `:77`, модель `:73-82`), human Command проверяется через route/binding. Мутант `human_requires_captured_scope` пойман |

## По моим прошлым находкам

- **B1–B3 и M1 закрыты.**
- **Деление терминальных состояний (cancelled_local/cancelled_remote и т.п.) автор не ввёл, и это допустимо.** Таблица `:127` определяет ACK как актуальное авторитетное evidence, а устаревшее и дублированное отсекается до reducer. Тогда консервативный reconcile на любой актуальный ACK после failed/cancelled корректен. Сама фильтрация остаётся непроверенным допущением, это работа T11/T28.
- **Остальные мелкие замечания учтены:** E15, filter-miss, O→G, наблюдения в pending, ordinary target, C04, намеренная бессрочная блокировка auto при unknown, порядок P12.

## Остаток, только редакционный

1. Spec `:82`: строка pending в таблице состояний не упоминает workflowCancellationRefs и scope для non-human. Противоречия нет, это покрыто в `:507`, но стоит поставить перекрёстную ссылку.
2. E15 стоит перед E14 (`:26-27`).

## Ограничения, которые сохраняются

- **Модель не независимое доказательство.** Это исполняемая спецификация, мутанты встроены в те же функции.
- **Модель не покрывает:** C07 (повтор безопасного enqueue), полноту producers и writers, SQL и блокировки (включая гонку deactivate с dispatch под SHARE/UPDATE), межпроцессный fencing коннектора и userbot journal, фильтрацию устаревших ACK, уникальность Message и Attachment XOR, всю машину E/P/C. Всё это остаётся для T-тестов (T11/T14/T28 и другие).
- **Независимость ревью ограничена.** В первом проходе Grep случайно показал строки из STATUS и cross-review. Полностью свободной от этого проверку я не объявляю.
