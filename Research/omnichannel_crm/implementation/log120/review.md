# LOG120 review

Independent readonly review found no confirmed blocker in the bounded stale-save
fix. It verified caller contracts: UserEntity return, lowercase-only normalization,
same-connection supplied runner, fresh locked admin/no-op/revocation decisions,
copied actor, finally invalidation and no notifications before known commit.

The reviewer requested a stronger concurrent-demotion assertion. The test now checks
that exactly one request succeeds and the other specifically rejects removal of the
last server administrator, rather than accepting any arbitrary database failure.

PostgreSQL tests cover both update/deactivate orders for all three writers, hard
deletion while waiting, concurrent unrelated changes, uncommitted caller data and
rollback, invalid runners, OTP drift/deletion/no-op, concurrent demotions, suppressed
UPDATE, real lost COMMIT acknowledgement, cache failure and normalized email output.

Fixture setup failures (missing workspace table and EntitySchema/target mismatch)
were fixed before acceptance; they were not runtime defects. Final targeted tests
pass 69/69 and general regression 1380/1380. No baseline relaxation was used.

Boundary: AdminPanelGuard still reads request.user flags; freshness of all already
authenticated requests is not solved by this writer. Creation/deletion of admins by
other owners and whole authentication/token lifecycle remain separate. Existing
event delivery/queue durability is not upgraded by the no-precommit-effects check.
