# LOG121 review

Independent readonly review found one FK planning defect: a child may have both
SET NULL and CASCADE paths. Its changed column can trigger a transitive UPDATE
before deletion. The guard now checks every cleared column, including rows also
scheduled for deletion. A real composite ON UPDATE CASCADE / ON DELETE NO ACTION
regression refuses that unproven effect before mutation.

The private boundary now requires an issued strict/exclusive scope before any
operation. Foreign operation workspace was already checked by the existing audit
context; the new negative test confirms that, rather than claiming a new fix.

Reviewer rechecked captured IDs, child lock/reread and FK race tests, mandatory
effect verification before and after journal rollback, and the unknown-commit
boundary. No remaining confirmed blocker in the scoped implementation was found.

The initial dependency guard rejected new imports into the full ORM metadata graph.
The implementation now receives a structural metadata projection from the existing
WorkspaceDataSource issuance registry. A second independent pass checked that
factory provenance, strict/exclusive lifecycle, canonical schema and root identity
remain enforced. The guard then passed without modifying its baseline.

Fixture setup mistakes (standard agent relation column names and required seed
fields) were corrected before passing tests. Early targeted failures were not
production behavior failures. Differential typecheck also caught an overly broad
boolean in the structural permission port and the fixture's sync-or-async context
return. The port now requires literal true; test callers normalize the promise.
Both were fixed without weakening compiler checks. All evidence distinguishes helper PostgreSQL tests
from adapted service orchestration, build/deployment and full HTTP acceptance.
