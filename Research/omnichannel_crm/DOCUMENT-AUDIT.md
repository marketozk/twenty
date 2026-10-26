# Проверка документов и задач — 26.10.2026

Проверен весь текущий корпус документов проекта (не тысячи upstream user-guide страниц Twenty): содержимое, статусы, повторяющиеся контрактные правила и локальные ссылки. Это consistency/source audit, не независимое кроссревью новой архитектуры. Дополнительно прочитаны PROJECT.md, CLAUDE.md, SKILLS.md и свежие описания/статусы всех 11 задач Linear.

## Найдено и исправлено

- Последние четыре R7 findings были только в proposal; теперь внесены в действующие spec/design/phase/API, отдельно от reviewer closure.
- Stable workflow identity больше не использует workflowVersionId; scope/delegation/pausing/reply budget объединены в одном контракте.
- Исторические исследовательские «архитектура/сборка ещё впереди» помечены как состояние на дату исследования.
- Roadmap перечислял skills без различия «подходит» и «выполнен»; добавлен проверяемый SKILLS-AUDIT.md.
- Текущие STATUS/PROJECT/registry/residual больше не говорят, что правки только запланированы.

## Учёт задач

ROB-762/763 — Done (сохраняется исторический scope). ROB-772 — In Progress, теперь проверка внесённых правок; ROB-764 — Todo/blocked. ROB-765–771 — Backlog. Описания всех 11 задач актуализированы из текущих phase документов; обратное чтение API подтвердило текст и статусы. Исторические отчёты остаются в комментариях и явно отмеченных завершённых этапах; публикация зафиксирована в DEVLOG LOG-011. Никаких runtime checks за этот аудит не добавлено.

## Индекс: 76 файлов до добавления этого отчёта

| Документ | Результат проверки / статус |
|---|---|
| [00-prompt-opening.md](00-prompt-opening.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [decisions.md](decisions.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/01-architecture.md](design/01-architecture.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/02-behavior.md](design/02-behavior.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/03-decisions.md](design/03-decisions.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/04-testing.md](design/04-testing.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/05-models.md](design/05-models.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/06-api.md](design/06-api.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/07-license-boundary.md](design/07-license-boundary.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/08-audit.md](design/08-audit.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [design/09-automation-contract.md](design/09-automation-contract.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [DEVLOG.md](DEVLOG.md) | Append-only журнал: старые записи исторические, актуален LOG-011 |
| [implementation/access-source.md](implementation/access-source.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [implementation/ai-workflow-source.md](implementation/ai-workflow-source.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [implementation/automation-source-hashes.json](implementation/automation-source-hashes.json) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [implementation/automation-source-matrix.md](implementation/automation-source-matrix.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [implementation/bypass-candidates.md](implementation/bypass-candidates.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [implementation/integration-map.md](implementation/integration-map.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [implementation/license-inventory.md](implementation/license-inventory.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [implementation/transactions-audit-source.md](implementation/transactions-audit-source.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [implementation/version-and-deploy.md](implementation/version-and-deploy.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [linear.md](linear.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [open-questions.md](open-questions.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/coverage.md](plan/coverage.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/cross-review/automation-redesign-proposal.md](plan/cross-review/automation-redesign-proposal.md) | Историческое предложение: перенесено в design/09 и spec |
| [plan/cross-review/claude-fresh.md](plan/cross-review/claude-fresh.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-initial.md](plan/cross-review/claude-initial.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r3-fresh.md](plan/cross-review/claude-r3-fresh.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r3-reconciliation.md](plan/cross-review/claude-r3-reconciliation.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r4-fresh.md](plan/cross-review/claude-r4-fresh.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r4-reconciliation.md](plan/cross-review/claude-r4-reconciliation.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r5-fresh.md](plan/cross-review/claude-r5-fresh.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r5-reconciliation.md](plan/cross-review/claude-r5-reconciliation.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r6-fresh.md](plan/cross-review/claude-r6-fresh.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r6-reconciliation.md](plan/cross-review/claude-r6-reconciliation.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r7-fresh.md](plan/cross-review/claude-r7-fresh.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-r7-reconciliation.md](plan/cross-review/claude-r7-reconciliation.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/claude-reconciliation.md](plan/cross-review/claude-reconciliation.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/cli-tool-audit.json](plan/cross-review/cli-tool-audit.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/registry.md](plan/cross-review/registry.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/cross-review/residual-r4.md](plan/cross-review/residual-r4.md) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/residual.md](plan/cross-review/residual.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/cross-review/review-manifest.json](plan/cross-review/review-manifest.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/review-r3-manifest.json](plan/cross-review/review-r3-manifest.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/review-r4-manifest.json](plan/cross-review/review-r4-manifest.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/review-r5-manifest.json](plan/cross-review/review-r5-manifest.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/review-r6-manifest.json](plan/cross-review/review-r6-manifest.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/review-r7-manifest.json](plan/cross-review/review-r7-manifest.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/source-evidence.json](plan/cross-review/source-evidence.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/source-r5-evidence.json](plan/cross-review/source-r5-evidence.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/source-r6-evidence.json](plan/cross-review/source-r6-evidence.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/source-r7-evidence.json](plan/cross-review/source-r7-evidence.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/cross-review/verification-r7.json](plan/cross-review/verification-r7.json) | Исторический evidence: сохраняется без переписывания результатов |
| [plan/current-steps.md](plan/current-steps.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/implementation-spec.md](plan/implementation-spec.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/phase_0_environment.md](plan/phase_0_environment.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/phase_1_data.md](plan/phase_1_data.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/phase_2_audit.md](plan/phase_2_audit.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/phase_3_access.md](plan/phase_3_access.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/phase_4_chat.md](plan/phase_4_chat.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/phase_5_ai_workflow.md](plan/phase_5_ai_workflow.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/phase_6_history.md](plan/phase_6_history.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/phase_7_acceptance.md](plan/phase_7_acceptance.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/README.md](plan/README.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [plan/roadmap.md](plan/roadmap.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [requirements.md](requirements.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [research-connectors.md](research-connectors.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [research-permissions-ai.md](research-permissions-ai.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [research-robot-api.md](research-robot-api.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [research-twenty-messaging.md](research-twenty-messaging.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [research.md](research.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [reuse-2.52.md](reuse-2.52.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [review.md](review.md) | Датированный source/операционный отчёт: факты отделены от текущего плана |
| [SKILLS-AUDIT.md](SKILLS-AUDIT.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [STATUS.md](STATUS.md) | Действующий документ: сверены ссылки/статусы и связанные правила |
| [upstream-2.52.json](upstream-2.52.json) | Датированный source/операционный отчёт: факты отделены от текущего плана |

Проверка текста и ссылок не означает доказанного отсутствия всех архитектурных дефектов. Последний независимый результат — R7; новая редакция ожидает независимой проверки. Исторические JSON manifests описывают прежние snapshots и не пересчитываются под новые документы.
