# LOG118 review

Readonly review found no blocker in the bounded strict owner, snapshot/savepoint,
actor capture, cache-finally or unknown-COMMIT implementation. It confirmed the
opposite membership-create ordering remains outside this owner: FK KEY SHARE waits
for user FOR UPDATE but permits insertion after soft deletion because id still exists.
This is recorded as the immediate next implementation boundary, not claimed covered.

New tests use a restricted runtime DB role with SELECT/INSERT-only audit grants:
actual deactivation, trusted actors, multiple former scopes, sensitive-data absence,
fresh memberships, retained memberships, no-op retry, absent scope, invalid scope,
pre-await copy, journal denial/corruption, mandatory mutation postconditions, two
concurrent deletions, actual lost COMMIT acknowledgement, cache failure, and a creator
committing before the deactivator acquires its row lock.

The two root tests verify explicit self-deletion refusal when fresh memberships
remain, and no invented workspace for an account with none. Existing tests now
assert account-owner dispatch and distinct membership/account operation IDs.

Final checks: 52 targeted/3 suites and 1320 regression/43 suites pass. Differential
types have zero new/changed-file errors (189/189 baseline). 26 guards pass, 10 migration
checksums unchanged, all 8 local/remote source hashes verified. No baseline relaxation.
