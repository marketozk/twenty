# LOG116 review

Independent read-only review found no blocker in the fresh exact membership lookup or
its error handling. It identified the second caller, delegated application tokens with
a user; active/soft-deleted tests and an application-without-user control were added.
No DI/dependency graph or token permission rules were broadened.

Initial new PG fixture: 18 passed. Existing strategy unit suite initially failed six
cases because fixtures omitted the flat membership userId/workspaceId or had no result
for the new authoritative repository read. Fixtures now explicitly supply valid core
membership while preserving their original native-member/impersonation scenarios.
All 29 existing unit cases then passed. No production guard was weakened to fit tests.

Expanded targeted run: 182 tests / 5 suites, including 21 new membership-auth cases.
The new tests exercise actual JwtAuthStrategy.validate, actual AccessTokenService
cookie/bearer bridge and PostgreSQL soft-delete filtering. JWT signature verification,
session resolution and unrelated DI services are adapters in this fixture. This does
not claim complete HTTP/bootstrap or an authorization fence for in-flight mutations.

Full regression: 1237/39 passed (203.9s). Initial differential types found a fixture-only
Object.assign intersection with private class properties (`never`); constructing typed
instances separately fixed it without changing production code. Targeted 182/5 passed
again after that test typing adjustment. Differential types pass: 190 baseline / 184
current diagnostics, zero new and zero changed-file errors. Six existing catch
clauses now narrow AuthException before reading its code; all 29 unit cases pass
again. The declared and locked @types/passport-jwt 3.0.13 was missing from the
isolated checker; adding its real package to both checks resolved four baseline
tooling diagnostics. No ambient fake declarations or baseline exemptions were added.
Existing Jest config emits its prior
unknown `silent` option warning; unrelated config was not changed.
