# LOG119 review

Readonly independent review found no blocker in the bounded patch. Both production
membership creators go through UserWorkspaceService.create: standalone invitation
and SignInUpService.signUpOnNewWorkspace's existing DataSource.transaction.
The latter does not catch create failures inside its callback; actual-effect failure
therefore rolls back the outer transaction. Its uncommitted new user remains visible
because validation/locking/INSERT share the caller connection. Development seeders
are not production creator coverage.

Runner activity, release state and data-source identity are checked before avatar I/O
and after it. Standalone create uses the existing strict core owner. A shared user
row lock blocks the deactivation owner; the actual inserted membership is verified
against its pinned id/user/workspace and both active flags. Locale UPDATE has an
active-row predicate and cannot insert or restore an entity.

PostgreSQL cases cover both lock orderings, inactive users, invalid caller runners,
uncommitted caller data and rollback, avatar failures/input capture, six actual INSERT
corruptions, lost standalone COMMIT acknowledgement and hard/soft-delete locale races.
The fixture runs the real service methods, TypeORM and SQL with restricted runtime
grants; unrelated dependency injection, entity metadata and avatar/file I/O are adapters.
This is not an end-to-end signup or HTTP proof. Caller-owned commit handling and
external avatar I/O keep their existing contracts; no global atomicity is claimed.

The review identified three further core User full-save paths. They are recorded in
[next boundary](next-boundary.md), not represented as fixed by membership creation.
