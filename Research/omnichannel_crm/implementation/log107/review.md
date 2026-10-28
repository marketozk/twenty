# Review LOG107

Read-only reviewer /root/native_transaction проверил repository call sites, locking,
builder SET/WHERE parity, lifecycle и batch/save/upsert. Найден обход через custom
BEFORE UPDATE trigger: payload name мог переписать companyId и каскадно изменить child.
Добавлен консервативный отказ для actual incoming mutating references при таком trigger;
paired populated/empty tests проходят. Arbitrary trigger-issued SQL вне покрытия.

Локальный dependency guard первоначально отклонил новые imports, транзитивно ведущие
к Enterprise. Исправлено передачей уже существующих compiler/WHERE и структурных типов;
baseline не изменён. Первая тестовая попытка исправила fixture: f.read требует id.
Сохранённый before.log — последующий реальный repro, resolved mutation вместо rejection.

Финальный read-only review после исправлений: новых блокеров в объявленной границе
не найдено. Следующий CASCADE обязан проверять retained omni child references под
child lock и не наследовать root detached-parent grant.

978 tests/33 suites PASS (191.233s); 166 targeted/4 suites PASS. 24 новых PostgreSQL cases. 26 guards PASS; 10 migration checksums неизменны. Types 347/349 roots, 189/189 прежних диагностик, 0 новых/changed-code. 6 local/remote source hashes совпадают.
