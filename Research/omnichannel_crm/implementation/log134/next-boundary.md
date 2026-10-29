# Next — remaining native message cleanup writers

The workspace-wide orphan sweep is now connected. The targeted association
cleanup path remains separate: cleanMessageAssociationsInScope and
deleteMessageAssociationsWithinTransaction, folder deletion, provider synchronization,
group email deletion and blocklist cleanup need an audit coverage pass.

Inspect all callers and their original scope/ownership lifecycle before reuse.
Preserve expectedRun/group-action fences and provider outcomes; do not upgrade
a shared ownership lock after rows have already been read or changed.

Reuse the closed private message/thread/target stages with an exact association
selection and one transaction owner, while preserving each current entrypoint's
atomicity. No public stage callback or skip-audit option. Audit actual association/
junction cascades and subsequent message/thread/target effects together where the
existing call already shares a transaction. Capture only server-derived identity.

Other ROB765 gaps remain in the acceptance table: calendar cleanup, other native
and metadata writers, real shares, public DESTROY/MERGE, denied/failed events and
health/alert. Full acceptance requires their checks and a later build/deployment
verification; current isolated passing tests do not close ROB765.
