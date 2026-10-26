# Проверка документов и задач — R11, 26.10.2026

Обновлены текущие spec/API/automation, конечные таблицы, source matrix, этапы1/5, coverage, STATUS/PROJECT/реестр/журнал. Старые отзывы и snapshots не переписаны. Проверка индекса/ссылок не означает независимое чтение каждой исторической строки или прохождение runtime tests. R11-B подтвердил пять затронутых ID; остальные48 остаются по прежней сверке. Общий fresh full pass отсутствует. [Итог](plan/cross-review/review-result.md).

Синхронизация11 существующих задач с API read-back фиксируется в DEVLOG LOG-013 после push; статусы и зависимости не меняются.

## Индекс 109 файлов кроме этого отчёта

| Файл | Проверка / предел |
|---|---|
| [00-prompt-opening.md](00-prompt-opening.md) | Текущий документ; ссылки/согласованность |
| [decisions.md](decisions.md) | Текущий документ; ссылки/согласованность |
| [design/01-architecture.md](design/01-architecture.md) | Текущий документ; ссылки/согласованность |
| [design/02-behavior.md](design/02-behavior.md) | Текущий документ; ссылки/согласованность |
| [design/03-decisions.md](design/03-decisions.md) | Текущий документ; ссылки/согласованность |
| [design/04-testing.md](design/04-testing.md) | Текущий документ; ссылки/согласованность |
| [design/05-models.md](design/05-models.md) | Текущий документ; ссылки/согласованность |
| [design/06-api.md](design/06-api.md) | Текущий документ; ссылки/согласованность |
| [design/07-license-boundary.md](design/07-license-boundary.md) | Текущий документ; ссылки/согласованность |
| [design/08-audit.md](design/08-audit.md) | Текущий документ; ссылки/согласованность |
| [design/09-automation-contract.md](design/09-automation-contract.md) | Текущий документ; ссылки/согласованность |
| [DEVLOG.md](DEVLOG.md) | Текущий документ; ссылки/согласованность |
| [implementation/access-source.md](implementation/access-source.md) | Текущий документ; ссылки/согласованность |
| [implementation/ai-workflow-source.md](implementation/ai-workflow-source.md) | Текущий документ; ссылки/согласованность |
| [implementation/automation-source-hashes.json](implementation/automation-source-hashes.json) | JSON validation; metadata/result scope внутри |
| [implementation/automation-source-matrix.md](implementation/automation-source-matrix.md) | Текущий документ; ссылки/согласованность |
| [implementation/bypass-candidates.md](implementation/bypass-candidates.md) | Текущий документ; ссылки/согласованность |
| [implementation/integration-map.md](implementation/integration-map.md) | Текущий документ; ссылки/согласованность |
| [implementation/license-inventory.md](implementation/license-inventory.md) | Текущий документ; ссылки/согласованность |
| [implementation/transactions-audit-source.md](implementation/transactions-audit-source.md) | Текущий документ; ссылки/согласованность |
| [implementation/version-and-deploy.md](implementation/version-and-deploy.md) | Текущий документ; ссылки/согласованность |
| [linear.md](linear.md) | Текущий документ; ссылки/согласованность |
| [open-questions.md](open-questions.md) | Текущий документ; ссылки/согласованность |
| [plan/coverage.md](plan/coverage.md) | Текущий документ; ссылки/согласованность |
| [plan/cross-review/automation-redesign-proposal.md](plan/cross-review/automation-redesign-proposal.md) | Текущий документ; ссылки/согласованность |
| [plan/cross-review/claude-fresh.md](plan/cross-review/claude-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-initial.md](plan/cross-review/claude-initial.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r10-finalcheck.md](plan/cross-review/claude-r10-finalcheck.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r10-fresh.md](plan/cross-review/claude-r10-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r10-reconciliation.md](plan/cross-review/claude-r10-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r11-finite-a.md](plan/cross-review/claude-r11-finite-a.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r11-finite-final.md](plan/cross-review/claude-r11-finite-final.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r11-reconciliation.md](plan/cross-review/claude-r11-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r3-fresh.md](plan/cross-review/claude-r3-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r3-reconciliation.md](plan/cross-review/claude-r3-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r4-fresh.md](plan/cross-review/claude-r4-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r4-reconciliation.md](plan/cross-review/claude-r4-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r5-fresh.md](plan/cross-review/claude-r5-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r5-reconciliation.md](plan/cross-review/claude-r5-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r6-fresh.md](plan/cross-review/claude-r6-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r6-reconciliation.md](plan/cross-review/claude-r6-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r7-fresh.md](plan/cross-review/claude-r7-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r7-reconciliation.md](plan/cross-review/claude-r7-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r8-fresh.md](plan/cross-review/claude-r8-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r8-reconciliation.md](plan/cross-review/claude-r8-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r8-targeted.md](plan/cross-review/claude-r8-targeted.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r9-finalcheck.md](plan/cross-review/claude-r9-finalcheck.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r9-fresh.md](plan/cross-review/claude-r9-fresh.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-r9-reconciliation.md](plan/cross-review/claude-r9-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/claude-reconciliation.md](plan/cross-review/claude-reconciliation.md) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/cli-tool-audit-r11.json](plan/cross-review/cli-tool-audit-r11.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/cli-tool-audit-r8-r10.json](plan/cross-review/cli-tool-audit-r8-r10.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/cli-tool-audit.json](plan/cross-review/cli-tool-audit.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/registry.md](plan/cross-review/registry.md) | Текущий документ; ссылки/согласованность |
| [plan/cross-review/residual-r4.md](plan/cross-review/residual-r4.md) | Текущий документ; ссылки/согласованность |
| [plan/cross-review/residual.md](plan/cross-review/residual.md) | Текущий документ; ссылки/согласованность |
| [plan/cross-review/review-manifest.json](plan/cross-review/review-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r10-b-manifest.json](plan/cross-review/review-r10-b-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r10-final-manifest.json](plan/cross-review/review-r10-final-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r10-manifest.json](plan/cross-review/review-r10-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r11-a-manifest.json](plan/cross-review/review-r11-a-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r11-a-model-snapshot.json](plan/cross-review/review-r11-a-model-snapshot.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r11-b-artifact-snapshot.json](plan/cross-review/review-r11-b-artifact-snapshot.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r11-b-manifest.json](plan/cross-review/review-r11-b-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r11-final-artifact-snapshot.json](plan/cross-review/review-r11-final-artifact-snapshot.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r3-manifest.json](plan/cross-review/review-r3-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r4-manifest.json](plan/cross-review/review-r4-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r5-manifest.json](plan/cross-review/review-r5-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r6-manifest.json](plan/cross-review/review-r6-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r7-manifest.json](plan/cross-review/review-r7-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r8-full-manifest.json](plan/cross-review/review-r8-full-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r8-targeted-manifest.json](plan/cross-review/review-r8-targeted-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r9-b-manifest.json](plan/cross-review/review-r9-b-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-r9-manifest.json](plan/cross-review/review-r9-manifest.json) | Историческое evidence/snapshot; не runtime proof |
| [plan/cross-review/review-result.md](plan/cross-review/review-result.md) | Текущий документ; ссылки/согласованность |
| [plan/cross-review/source-evidence.json](plan/cross-review/source-evidence.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/source-r5-evidence.json](plan/cross-review/source-r5-evidence.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/source-r6-evidence.json](plan/cross-review/source-r6-evidence.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/source-r7-evidence.json](plan/cross-review/source-r7-evidence.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/verification-r10.json](plan/cross-review/verification-r10.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/verification-r7.json](plan/cross-review/verification-r7.json) | JSON validation; metadata/result scope внутри |
| [plan/current-steps.md](plan/current-steps.md) | Текущий документ; ссылки/согласованность |
| [plan/decision-tables.md](plan/decision-tables.md) | Текущий документ; ссылки/согласованность |
| [plan/implementation-spec.md](plan/implementation-spec.md) | Текущий документ; ссылки/согласованность |
| [plan/phase_0_environment.md](plan/phase_0_environment.md) | Текущий документ; ссылки/согласованность |
| [plan/phase_1_data.md](plan/phase_1_data.md) | Текущий документ; ссылки/согласованность |
| [plan/phase_2_audit.md](plan/phase_2_audit.md) | Текущий документ; ссылки/согласованность |
| [plan/phase_3_access.md](plan/phase_3_access.md) | Текущий документ; ссылки/согласованность |
| [plan/phase_4_chat.md](plan/phase_4_chat.md) | Текущий документ; ссылки/согласованность |
| [plan/phase_5_ai_workflow.md](plan/phase_5_ai_workflow.md) | Текущий документ; ссылки/согласованность |
| [plan/phase_6_history.md](plan/phase_6_history.md) | Текущий документ; ссылки/согласованность |
| [plan/phase_7_acceptance.md](plan/phase_7_acceptance.md) | Текущий документ; ссылки/согласованность |
| [plan/README.md](plan/README.md) | Текущий документ; ссылки/согласованность |
| [plan/roadmap.md](plan/roadmap.md) | Текущий документ; ссылки/согласованность |
| [plan/verification/check_decisions.py](plan/verification/check_decisions.py) | Исполняемая абстрактная спецификация; не код CRM |
| [plan/verification/model-result.json](plan/verification/model-result.json) | JSON validation; metadata/result scope внутри |
| [requirements.md](requirements.md) | Текущий документ; ссылки/согласованность |
| [research-connectors.md](research-connectors.md) | Датированный источник; актуальный контракт в spec |
| [research-permissions-ai.md](research-permissions-ai.md) | Датированный источник; актуальный контракт в spec |
| [research-robot-api.md](research-robot-api.md) | Датированный источник; актуальный контракт в spec |
| [research-twenty-messaging.md](research-twenty-messaging.md) | Датированный источник; актуальный контракт в spec |
| [research.md](research.md) | Датированный источник; актуальный контракт в spec |
| [reuse-2.52.md](reuse-2.52.md) | Текущий документ; ссылки/согласованность |
| [review.md](review.md) | Текущий документ; ссылки/согласованность |
| [SKILLS-AUDIT.md](SKILLS-AUDIT.md) | Текущий документ; ссылки/согласованность |
| [STATUS.md](STATUS.md) | Текущий документ; ссылки/согласованность |
| [upstream-2.52.json](upstream-2.52.json) | JSON validation; metadata/result scope внутри |
| [plan/cross-review/verification-r11.json](plan/cross-review/verification-r11.json) | JSON validation / R11 evidence metadata |
| [plan/cross-review/review-r11-published-manifest.json](plan/cross-review/review-r11-published-manifest.json) | JSON validation / R11 evidence metadata |
