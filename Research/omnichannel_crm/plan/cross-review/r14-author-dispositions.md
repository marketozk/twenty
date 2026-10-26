# R14 disposition proposed by author
F1 -> N-33: schema now has immutable OmniExecutionReference + reference FK and phase/retention constraints.
F2 -> M-7/H-3: exact runCoreWorkflowVersion source read confirms client runId and any version. Legacy governed entry rejected including DRAFT; new startOmniWorkflow uses protected MANUAL. Test DRAFT explicitly unavailable v1 rather than broad principal. Existing every-start invariant retained.
F3 -> N-6: duplicate lock tuple removed in favor of canonical anchor. Introduced by previous-round lock refinement not reaching derived table.
F4 -> N-29: connector registry global commandId uniqueness across owners plus immutable historical owner auth; no cross-owner replay/read permission from knowledge of ID.
F5 -> N-21: send response current authorized reply/control revisions and mode under lock; idempotent replay returns same command but fresh projection; UI monotonic merge. Previous replyRevision fix incompletely covered takeover_on_send response.
F6 -> L-2: trusted history_import canonical enum and two derived literals normalized.
F7 -> N-34: resolveCommandOutcome with scoped evidence verification, durable CommandResolutionRequest, current auth/recheck, same receipt reducer, unresolved retains auto fence. No operator status override or send.
All fixes are in plan owners and phase/API derivations, no runtime. Existing63 roots kept; seven manifestations, no new independent root proposed. Author independent report was saved before reading your A; author did not find these before you, do not claim shared initial discovery.
