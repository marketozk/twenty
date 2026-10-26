# Этап B, раунд R14: сверка исправлений F1–F7 и 63 стабильных ID

## Итог

**Вердикт: ready_for_implementation** — но только по этой правке и по сверке реестра. Это не новый полный слепой проход A после изменений. Продуктовые гейты G01–G20 не выбраны, runtime не исполнялся, T01–T33 не существуют.

- **F1–F7:** все 7 закрыты, в текущем тексте есть доказательства.
- **63 стабильных ID:** все 63 подтверждены как `closed_in_plan` по текущему тексту.
- **Новые находки:** 2 проявления уровня Low внутри существующих ID (N-6 и L-2). Новых корневых причин нет. Обе мелочи на реализацию не влияют, их можно поправить попутно.

---

## 1. F1–F7: проверка по текущему тексту

### F1 → N-33 — **closed**
- **Что исправлено:**
  - `implementation-spec.md:76` — новая сущность `OmniExecutionReference`. В ней все поля из `workflow-execution.md:330` плюс `capturedResourceScope` с ревизиями рёбер и `parentReferenceId`. Запись неизменяемая, создаётся только сервером, внешние ключи составные по тенанту, scope потомка может только сужаться.
  - FK `referenceId` добавлены: `OutgoingCommand` (:48, обязателен для non-human), `ConsumerReceipt` (:51, обязателен для governed-потребителей), `OmniAutomationTurn` (:77). У `RunIntent` и `ArtifactScope` он уже был.
- **Проверил контрпримеры:**
  - Срок жизни reference — :84: хранится не меньше, чем живут ссылающиеся intents, Commands, artifacts и replay evidence. Удаление родителя не позволяет восстановить reference из текущих прав.
  - Restore ABA (та же числовая эпоха после restore) — reference несёт `restoreIncarnation` и сверяется с `WorkspacePolicyState.restoreIncarnation` (:67, §15.24).
  - Ранние nullable-колонки — :84 прямо запрещает automation без reference.
  - Связь имени из контракта с таблицей — `workflow-execution.md:360` («Reference storage определяется только schema §3»).

### F2 → M-7/H-3 — **closed**
- **Что исправлено:**
  - `workflow-execution.md:354–360` (новый якорь `manual-editor-ingress`): `runCoreWorkflowVersion` и все прямые вызовы `CoreWorkflowRunnerService.run` классифицируют весь flow, включая DRAFT, до первого шага. Для governed flow старый путь отказывает, `workflowRunId` от клиента запрещён.
  - Новая операция `startOmniWorkflow`: idempotencyKey + payloadHash, root формирует сервер, runId канонический, только опубликованная версия (`06-api.md:31`).
  - Кнопка «Тест» для governed DRAFT в v1 явно запрещена до синтетического режима G14.
  - T25-F расширен; `phase_5:54`.
- **Сверка с кодом:** в пакете ровно три прямых вызова runner — `workflow-trigger.job.ts`, `core-workflow-run.resolver.ts`, `workflow-trigger.controller.ts`. Правило «все прямые callers» их покрывает. Отдельного эндпоинта теста шага workflow я не нашёл. WEBHOOK без ключа отклоняется по `workflow-execution.md:130`.
- **Остаток, не дефект:** MANUAL запускает только опубликованная версия, а conversation из payload не берётся — его определяет G07. Небезопасного пути это не создаёт.

### F3 → N-6 — **closed**
- `decision-tables.md:75` теперь только ссылается на `access-control.md#lock-protocol`. Свой порядок блокировок в производной таблице удалён.

### F4 → N-29 — **closed**
- **Что исправлено:** `implementation-spec.md:365–366` — `UNIQUE(commandId)`, `ownerInstance` неизменяемый и в ключ дедупликации не входит. :369 — повтор от другого владельца отклоняется и не раскрывает прежний результат; к историческим данным допускается только узкий сервис reconciliation.
- **Проверил контрпримеры:**
  - Смена владельца — повторная запись не создаётся. Это согласуется с `sending-ui.md:43` («uniqueness по commandId»).
  - Межтенантная дедупликация — commandId генерирует сервер CRM (UUID), клиентам он не выдаётся. Захват чужого ID требует знать UUID и всё равно приводит к отказу, без раскрытия данных.
- **Замечание о привязке к корню:** по смыслу F4 ближе к N-5 (границы журнала, владельца и отмены в коннекторе), чем к N-29. На статус это не влияет.

### F5 → N-21 — **closed**
- **Что исправлено:** `sending-ui.md:55` — send возвращает `{commandId, state, replyRevision, controlEpoch, mode}`. Это актуальная проекция под общей блокировкой, в том числе при повторе уже принятого ключа. UI применяет версии монотонно. Добавлены T12 и `phase_4:39`.
- **Проверил контрпример:** повтор ключа без права доступа. Возврат прежней Command идёт только после текущей авторизации (:57), поэтому проекция не утекает.

### F6 → L-2 — **closed**
- Единое значение `history_import`: `sending-ui.md:29`, `02-behavior.md:64`, `phase_6:16`, spec :120. Других литералов `origin=import` в плане нет. Единственное совпадение — описательная строка в `ai-workflow-source.md:115`.

### F7 → N-34 — **closed**
- **Что исправлено:**
  - `sending-ui.md:77–85` (`outcome-resolution`): отдельное право `command.reconcile`. Сервер сам получает доказательство через scoped adapter и сверяет commandId, исторического владельца, binding, generation, native ID и hash.
  - Сохраняемый `CommandResolutionRequest` (spec :50) с PG lease. Права перепроверяются перед применением.
  - Результат проходит через тот же receipt reducer, что и обычные квитанции. Монотонные guard'ы не дают откатить sent.
  - Если доказательств недостаточно — `unresolved`, команда остаётся `outcome_unknown`, блок auto сохраняется.
  - `06-api.md:30`, spec :84 и :367, `phase_4:39`.
- **Проверил контрпримеры:**
  - Падение процесса — lease и идемпотентное восстановление.
  - Отзыв прав во время проверки — повторная проверка перед применением; без права исход остаётся unknown, ничего не теряется.
  - Подложное или чужое доказательство — сверка с историческим владельцем и binding.
  - Позднее обычное подтверждение (receipt) после resolution — reducer идемпотентен, sent→sent не меняет состояние, противоречие уходит в видимый reconciliation.

---

## 2. Новые находки (2 × Low, без нового корня)

### B14-1 — Low, проявление N-6
- **Проблема:** в `access-control.md:37` не указано место `CommandResolutionRequest` в порядке блокировок. Применение resolution берёт сразу request, Command и Receipt.
- **Сценарий:** если реализация возьмёт request после Receipt, а обычный путь квитанций — наоборот, возможен deadlock. Его поймает только T28 с обратным порядком блокировок.
- **Правка:** добавить в протокол «… → Command → CommandResolutionRequest → Receipt». Отдельно указать, что `OmniExecutionReference` неизменяем и не блокируется.

### B14-2 — Low, проявление L-2 (редакционное)
- **Проблема:** в `implementation-spec.md:369` абзац вставлен внутрь таблицы коннектора. Строка `checkpoints` (:370) оказалась вне таблицы и при отображении потеряет заголовок.
- **Правка:** перенести абзац :369 после строки :370.

Ещё одна мелочь, отдельной находкой не считаю: в `workflow-execution.md:330` используется имя `TrustedExecutionReference`, а в §3 — `OmniExecutionReference`. Связь между ними задана в :360.

---

## 3. Сверка 63 стабильных ID по текущему плану

Каждому ID указано место в текущем тексте, где лежит закрывающее правило. Разделы, которые эта правка не трогала, я в этапе B заново целиком не читал. Опора — полное чтение тех же файлов этого пакета в этапе A этой сессии, точечные Grep (19 ключевых маркеров найдены в spec) и перечитывание §3, §4, §5, контрактов-владельцев и изменённых мест. Исходные формулировки прошлых раундов (файлы `claude-r*.md`) в пакет не входят, поэтому сверка идёт по описанию причин в реестре.

| ID | Статус | Где закрыто в текущем тексте |
|---|---|---|
| H-1 | closed_in_plan | §15.1, ACL на timeline/fallback, T21 |
| H-2 | closed_in_plan | §15.1 cleaners, §15.8 RESTRICT/purge, §15.21 TrashCleanup, §15.23 destroy, T22 |
| H-3 | closed_in_plan | access-control#scope; workflow-execution design-6…16, 24; **новый** manual-editor-ingress (F2) |
| H-4 | closed_in_plan | turn-lifecycle, action-idempotency, OmniEffectLedger §3, T26 |
| H-5 | closed_in_plan | §15.4, §15.24 restoreIncarnation, reference несёт incarnation (F1), T29 |
| H-6 | closed_in_plan | §15.2, §15.7 echo, §15.24 provenance, T24 |
| M-1, M-2 | closed_in_plan | §15.3, §15.7 tombstone, closed-status, command-cancellation, global cancel UNIQUE (F4), T28 |
| M-3 | closed_in_plan | §15.2, legacy namespace SaleBot |
| M-4 | closed_in_plan | §15.2, sourceEventKey и nativeMessageKey разделены, T01/T11 |
| M-5 | closed_in_plan | §15.2, разделение строк при merge и lifecycle adapter, T23 |
| M-6 | closed_in_plan | §15.5 OmniMessageRevision, §15.25 purge-manifest, T32 |
| M-7 | closed_in_plan | design-18…22, run-identity, coverage, cancellation, runner-*, **manual ingress** (F2), T14 |
| M-8 | closed_in_plan | §15.8 роли crm_audit, T06 |
| M-9 | closed_in_plan | §15.5 и §3 StageRule UNIQUE, T30 |
| M-10 | closed_in_plan | §15.5, preflight тестовой среды, G14 |
| M-11 | closed_in_plan | §15.5, §15.8, §15.19, fork-runner/ledger, T33 |
| M-12 | closed_in_plan | §4, unbound identity без угадывания Person |
| M-13 | closed_in_plan | design-31/32, общий slot и burst handoff, T27 |
| M-14 | closed_in_plan | design-49, root.conversationId через G07 |
| L-1 | closed_in_plan | §3, writer CrmAuditEntry в ROB-764 |
| L-2 | closed_in_plan + новое Low B14-2 | §13 G01–G20, history_import (F6); B14-2 редакционное |
| L-3 | closed_in_plan | §15.5, каталог аудита, T19 |
| L-4 | closed_in_plan | §15.1, re-enable сохраняет bindingId |
| L-5 | closed_in_plan | §15.5, native role через тот же fence, T31 |
| L-6 | closed_in_plan | §15.5 и §15.16, проверка прав на каждый batch |
| L-7 | closed_in_plan | §15.1 domain-only, §15.18 исключение omni из rematch, T05/T22 |
| N-1 | closed_in_plan | §15.6 производные объекты, §15.12 AutomationArtifactScope |
| N-2 | closed_in_plan | §15.6 QueueGrant, §3 OmniQueue, G08 |
| N-3 | closed_in_plan | design-11 и design-15, pausing tools, T27-A |
| N-4 | closed_in_plan | §15.6 instance-admin export и impersonation |
| N-5 | closed_in_plan | §15.7, §15.25, регистр :369 (F4) |
| N-6 | closed_in_plan + новое Low B14-1 | lock-protocol; decision-tables ссылается на владельца (F3) |
| N-7 | closed_in_plan | §15.7 capture generation, command-states stale_generation |
| N-8a | closed_in_plan | §15.9, ограниченный поиск |
| N-8b | closed_in_plan | §3 immutableAuthorSnapshot, §15.7 |
| N-8c | closed_in_plan | §15.6, API-key principal |
| N-9 | closed_in_plan | §15.10, namespaced headerMessageId |
| N-10 | closed_in_plan | auto-admission + G13b; resolution сохраняет блок (F7) |
| N-11 | closed_in_plan | §15.11, передача custodian |
| N-12 | closed_in_plan | §15.11, исторический автор |
| N-13 | closed_in_plan | §15.13 и §15.18, manifest/CI, G18 |
| N-14 | closed_in_plan | sender-mode, takeover |
| N-15 | closed_in_plan | epochs, lock-protocol, policy-writers; доказательство нагрузкой T19 — будущий runtime |
| N-16 | closed_in_plan | §15.16 fetchHistoryPage |
| N-17 | closed_in_plan | §15.17 CrmRecordRevision |
| N-18 | closed_in_plan | §15.18, guard метаданных |
| N-20 | closed_in_plan | send-action, SEND_OMNI_MESSAGE |
| N-21 | closed_in_plan | human-stale-view + проекция в ответе send (F5) |
| N-22 | closed_in_plan | §15.21, ключи в §15.23, §15.24 fallback |
| N-23 | closed_in_plan | closed-status |
| N-24 | closed_in_plan | §3 InternalNote UNIQUE + hash |
| N-25 | closed_in_plan | §15.23, перенос AttachmentLink с команды на сообщение |
| N-26 | closed_in_plan | read-authority, только primary |
| N-27 | closed_in_plan | §7 и §3 ConversationTarget |
| N-28 | closed_in_plan | sending-ui#reply |
| N-29 | closed_in_plan | sending-ui#fifo + глобальный commandId в коннекторе (F4) |
| N-30 | closed_in_plan | scope, read-only assist |
| N-31 | closed_in_plan | read-authority, native inputs внутри fence; доказательство T31 — будущий runtime |
| N-32 | closed_in_plan | sending-ui#timeline |
| N-33 | closed_in_plan | §3, включая OmniExecutionReference и CommandResolutionRequest (F1) |
| N-34 | closed_in_plan | 06-api, включая resolveCommandOutcome и startOmniWorkflow (F7, F2) |
| N-35 | closed_in_plan | §3 AutomationAdmission, §5 монотонная граница activation |

**Итого:** 63/63 `closed_in_plan`. Открытых major и minor нет. Два новых Low (B14-1, B14-2) — проявления N-6 и L-2. Ни один риск не принят за владельца.

---

## 4. Ограничения

- Это этап B (сверка), а не свежий полный A. После текущей правки полного слепого прохода не было.
- `RECONCILIATION/codex-r14-review.md` я не читал, чтобы не опираться на выводы автора. Читал только dispositions и реестр.
- Код внешних коннекторов и юзерботов недоступен. Их квалификация остаётся условием до активации каналов.
- `check_decisions.py` не запускал. Хэши пакета не сверял.
- Доказательства нагрузкой и конкурентностью (T19, T31 и другие) относятся к будущему runtime.

Деплоя, сообщений клиентам, записи файлов, сети и MCP не было. Карточку задачи не обновлял: в этом прогоне она запрещена.