# LOG105 — внутреннее физическое удаление с аудитом

ROB765 In Progress. Включён `delete` внутри opt-in nativeAudit owner для покрытых
Company/Person/Opportunity и local custom objects. Публичные DESTROY/MERGE этим
срезом не подключены; обычный путь сохраняется.

После sorted FOR UPDATE проверяются все входящие FK-ссылки, включая soft-deleted,
composite и self-reference. При любой существующей ссылке — отказ до DELETE.
Проверка извлечена из существующего omni helper, его retained-parent guard и
domain capability не обходятся. Непустые FILES отказаны; очистка recordShare и
вложений не добавляется скрыто.

Внутренний RETURNING id определяет actual deleted rows; caller selection сохраняется.
Before snapshot и отсутствие строк после DELETE подтверждаются в том же executor.
Delete audit хранит exact objectMetadataId/resourceId и closed deletedRecord.access
currentWorkspaceAdministration. Значения не попадают в журнал. Это descriptor для
будущего чтения/экспорта ROB767, не новая реализация административных прав.

Events и stock callbacks остаются после confirmed commit. При trigger-skipped rows
DESTROYED фильтруется по actual RETURNING; all-skipped не даёт ложного события.
Audit failure/caller-caught error откатывают owner; lost actual COMMIT ACK остаётся
unknown без retry/ROLLBACK. Create→delete сохраняет отдельные action events одной
operation; общий replay протокол не добавляется.

Проверки: четыре metadata-типа, bulk/unmatched/selection, audit failure, permission,
CASCADE/SET NULL/RESTRICT, composite soft-deleted child, FILES, retained omni identity,
caller-caught poison, trigger skip/resurrection, оба порядка реальной FK гонки и ACK.
Пять descriptor rejection cases проверяются отдельно без PostgreSQL mutation.

До общей готовности остаются другие writers, FK side effects, FILES destruction,
public DESTROY/MERGE, metadata/roles и negative audit/health. Образ и демо этим
срезом не менялись; внешних сообщений и GitHub Actions нет.

935 tests/31 suites PASS (180.29s); 124 targeted/4 suites PASS. 30 новых cases: 25 PostgreSQL и 5 descriptor-only. 26 guards PASS; 10 migration checksums неизменны. Types 341/343 roots, 189/189 прежних диагностик, 0 новых/changed-code. 9 local/remote source hashes совпадают.
