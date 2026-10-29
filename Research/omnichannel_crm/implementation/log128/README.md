# LOG128 — captured deletion criteria and historical command execution

The closed deletion owner requires one of four captured boundaries: administrative
account deletion, pinned email-group channel, manifest provider removal, or provider
scope repair. Active membership/provider prerequisites are locked and checked through
COMMIT. Permission checks receive a frozen four-field account projection, no runner.

Both actual command execution paths wrap the historical provider-scope repair with
its exact registered metadata identity. A one-shot workspace source is separate from
audit attribution and expires when execution ends, including detached async work.
Other commands cannot inherit that repair source. The committed 2.51 command is intact.

The expanded PostgreSQL suite covers stale selection, unavailable/foreign/deleted
membership, pinned email-group, manifest ownership, provider rebinding/scope changes,
captured maps, post-audit corruption and both orders of member/provider write races.
Execution tests cover actual CLI/upgrade runners, metadata mismatch, foreign workspace,
repeated consumption, nested masking, concurrent scopes and detached work.

Production deletion services have not yet been switched. Final integration must consume
the source before hooks, require complete effects where later provider removal can
cascade, and pin the email send-domain context. Role cache freshness, provider effects,
native cleanup, full HTTP/build/deployment remain separate. ROB765 stays In Progress.

[Design](design.md), [review](review.md), [results](results.json),
[source hashes](source-snapshot.json), [next integration](next-boundary.md).
