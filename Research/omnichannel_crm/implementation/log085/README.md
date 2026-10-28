# LOG-085: opt-in live automatic Person creation

The existing binding.defaults.update accepts optional autoCreatePersonEnabled.
Omission preserves the current value and old payload hashes. Explicit enabling exposes
a distinct current administrator/create authorization fact, including retained replay.
CAS/revision/policy epoch, audit, configuration event and wakeup share one commit.
Default remains disabled. No schema/migration change or public endpoint is added.

Qualified incoming adapter apply takes policy UPDATE from the start. It may create
Person only for a new processing trusted-live incoming complete message.received,
verified unbound identity and enabled current binding; source result must be created,
advanced or duplicate. Stale events, edits, deletes, placeholders, import and restore
never auto-create. A distinct mandatory current create authorizer receives both the
identity/old conversations and the current incoming conversation/queue facts. General
ingress permission alone does not grant creation. Existing full runtime ACL is pending.

The same-scope LOG084 create primitive is reused, with one shared native repository
port for explicit and automatic creation. Person, identity/previous FROM participants,
policy epoch, child receipt/audit, message/revision and incoming receipt are atomic.
Child operation/key derive from incoming receipt ID, with a server-owned system actor;
its audit does not contaminate the outer message replay proof. No nested transaction,
contact matcher, guessed email/phone or automatic conversation target. The initial
label is sourceDisplayName normalized for controls, trim and 256 UTF-16 units; absent
label uses the verified providerPeerId as an identifier, never an invented name.
lastName remains empty. Name is redacted in audit.

Import-to-live duplicate creates one Person and binds prior participants without
rewriting immutable birth snapshots. Applied receipt replay only verifies retained
child proof and never creates again, including after disable or manual unlink. Later
legitimate Person-name edits remain valid. Missing child receipt/audit fails closed.
Native input and birth snapshot use the updated identity. Fresh child Person/identity
are reread after the final outer receipt write; retained replay does not restore names.

170 tests/5 suites +26 guards =196 PASS;34 new PG cases. Differential typecheck 318 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
34 new cases:6 configuration and28 automatic creation cases. Real PostgreSQL tests
cover first Conversation/Thread, imported duplicate, placeholder completion, excluded
origins/kinds/stale input, current and missing create permission, disabled/omitted
settings, CAS/race/key conflicts, two concurrent messages +20 retries, five failure
stages, real COMMIT ACK loss, receipt/audit proof removal, manual unlink with flag both
on/off, two late corruption triggers and lease expiry before final receipt CAS.
The focused run also covers existing explicit creation and history/revision pipelines.
The first test setup incorrectly passed bindingId to a closed configuration principal
and counted pre-existing stock callbacks; both fixture mistakes were corrected.
The typecheck caught five errors from losing the generic issued-scope type during port
extraction; using the existing manager callback type fixes them without adding an
Enterprise dependency. Guard baseline was not changed. Type diagnostics remain187.

Read-only source review found the late Person/identity postcondition gap; final fresh
readback plus two trigger regression cases fixes it. Re-review found no further blocker.
Review also identified outstanding phase1 acceptance work: permitted parent destroy
adapter under spec15.21 and a current actual startup/restart smoke for nine migrations.
Fresh full Jest alone would not establish either. ROB-764 remains In Progress.
Governed Person-created notification/target intents remain ROB-769; audit is not a
substitute for visible events. Producer inventory now names this automatic caller.

No live demo change, external messages, route activation or GitHub Actions.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: disable the binding setting through the authorized configuration writer; retain created people, immutable message history, identity transitions and receipts. Do not delete committed data or replay creation as a new command. No schema rollback is required.
