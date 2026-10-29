# Next — closed audited orphan sweep and actual entrypoints

Move the three internal message/thread/target stages behind a narrow closed
orchestrator. Preserve existing terminal facades. No public stage injection,
skip-audit parameter or arbitrary mutation callback.

Within one strict/exclusive transaction:
1. Capture server-derived identity and required metadata/DDL locks.
2. Page live messages by stable ID cursor; collect actual affectedThreadIds.
3. Reconcile each affected thread with surviving live messages once.
4. Page empty live threads; any message, even trashed, remains a blocker.
5. Verify all final effects, flush one audit context, drain deferred triggers,
   verify again, and commit.

Keep whole-sweep rollback; test multi-page/protected-first-page progress and
actual-only IDs. Review reduced intermediate target events explicitly.

Connect five callers: channel/account/blocklist jobs, reset/remove commands.
Capture identity before awaits, use fresh operation IDs with shared correlation.
Remove-orphans must respect dry-run and propagate unsafe outcomes. The actual
workspace iterator must preserve those errors despite existence/cache/logging
failures and stop subsequent workspaces; normal report behavior stays unchanged.
Reuse the existing unsafe queue guard, not a second retry protocol.
