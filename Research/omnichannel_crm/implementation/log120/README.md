# LOG120 — active core user updates

UserService email verification and email change no longer save an old complete User.
They update only their intended fields with an active-row predicate, return a fresh
UserEntity and use the strict core owner for standalone calls. A supplied runner must
be active, unreleased and from the same data source; its transaction/cache completion
remain the caller's responsibility. Email retains lowercase-only normalization and
the propagation job receives the committed normalized address.

Server administrator changes now lock active full administrators and the target in
id order after OTP. The fresh target determines no-op, omitted flags and last-admin
protection. Only the two flags are updated; stale entities cannot restore deletion or
overwrite unrelated concurrent changes. Actor data is copied before OTP.

Both standalone owners invalidate cache in finally, including unknown COMMIT.
Failed invalidation is logged without replacing the transaction result. Notifications
and propagation jobs run only after a confirmed successful change; unknown outcome
does not retry or claim delivery.

69 targeted tests/3 suites PASS (6.517s), including 37 new PostgreSQL cases.
The general regression passes 1380 tests/45 suites (209.814s).
The fixture runs actual service methods/SQL/strict owners with restricted DB grants.
Entity metadata, unrelated DI, OTP, queue and notification delivery are adapters.
This is not a live email/HTTP or complete authorization test.

[Results](results.json), [independent review](review.md), [next boundary](next-boundary.md).
ROB765 remains In Progress; no deployment or GitHub Actions.
