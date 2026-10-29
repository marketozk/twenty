# Next — active-user fence for membership creation

UserWorkspaceService.create currently saves directly (optional caller QueryRunner).
The user FK proves existence, not active deletedAt. Put fresh user FOR SHARE and
active-user validation in the same transaction as INSERT; use the existing strict
core owner when there is no caller runner. Verify ownership/active state for supplied
runners and inspect every call site before changing their contract.

Test both orders with real PostgreSQL: creator first makes deactivation observe an
active membership; deactivator first makes the creator reject the deleted user.
Do not claim all writers covered until direct inserts/saves/upserts and recovery
paths are inventoried. Preserve caller transaction rollback/unknown semantics.

Readonly caller inventory: addUserToWorkspaceIfUserNotInWorkspace calls create
without runner; SignInUpService.signUpOnNewWorkspace calls it inside
DataSource.transaction with the same runner that saved the new user. No other
production INSERT/upsert found; dev seed-user-workspaces remains development-only.
Do not open a second connection for a caller's uncommitted new user.

Also replace updateUserWorkspaceLocaleForUserWorkspace's findOne + save(full entity)
with locale-only UPDATE by id AND deletedAt IS NULL. The old save can reinsert after
hard removal or restore stale deletedAt:null after soft removal, bypassing create.
Capture scalar input before avatar await; validate active/not-released/same-source
runner, verify actual inserted ID/user/workspace/deletedAt, and test trigger rewrite.
Keep avatar file I/O outside the short standalone transaction; do not claim it atomic.

Further source-confirmed revocation residual: core UserService.markEmailAsVerified
and updateEmailFromVerificationToken load full User then save it; AdminPanelServerAdminService
also saves a previously loaded User. These can restore stale deletedAt after deactivation,
just like membership locale-save. Inventory their email normalization, return and
last-server-admin semantics before replacing them with narrow active-row updates.
Do not call account revocation globally fenced while those old writers remain.

Native-member audit and its system/transitive FK effects remain as documented in
[LOG117 next boundary](../log117/next-boundary.md); do not conflate them with core account audit.
