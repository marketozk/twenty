# Next — active core user updates

Three source-confirmed stale full-entity saves remain: UserService.markEmailAsVerified,
UserService.updateEmailFromVerificationToken and AdminPanelServerAdminService.updateServerAdminAccess.
Each can overwrite a concurrent change or restore deletedAt from an old entity.

Use narrow active-row updates and fresh returned entities. Email must retain the
existing listener's lowercase behavior (not introduce trimming in this lower-level
writer). The email propagation job must receive the committed normalized value.
Supplied QueryRunner stays on the same active connection and retains outer ownership.

Admin access must be computed from fresh locked state after OTP, including no-op
and last-full-admin decisions. Lock active full administrators and target in a stable
order, recheck the target and remaining admins, update only the requested flags.
Preserve two-factor checks and existing notifications; no side effects before commit.

Test deactivation/update orderings, no resurrection after hard deletion, concurrent
unrelated changes, returned entity/normalization, concurrent last-admin demotions,
OTP-await drift and lost COMMIT acknowledgement. New-user creation is a separate
insert path; password UPDATE is already narrow, with token lifecycle still separate.

Native member audit, real shares, remaining public destroy/merge and other ROB765
acceptance criteria remain open. See [native boundary](../log117/next-boundary.md).
