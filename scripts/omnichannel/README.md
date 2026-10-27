# Enterprise dependency guard (ROB-764)

Run from the repository root:

```sh
python -m unittest discover -s scripts/omnichannel -p 'test_enterprise_dependencies.py' -v
python scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline
```

The baseline is generated **only** from pinned upstream commit
`729f6236126eddaa68d176fb766bc349b19de11d`, using `--write-baseline`.
CI regenerates it in memory and rejects any difference. It cannot be refreshed
from the working tree to silently bless a newly introduced dependency.
The JSON stores Enterprise paths, known direct inbound edges, dynamic/unresolved
debt and digests/counts of the full transitive graph. Its sorted `paths` dictionary
uses integer references to avoid repeated long paths. Every check reconstructs the
full pinned graph in memory and verifies the stored manifest before comparison;
the digest is not used as a substitute for checking individual new graph edges.

The guard starts from every non-test source file in twenty-server, twenty-front,
twenty-shared and twenty-ui. It follows imports and re-exports into other local
packages, includes type-only imports conservatively, and resolves relative paths,
package tsconfig path aliases and source package subpath barrels. Imported Nest
modules/providers/factory classes are therefore included even before DI runs.
Literal `import()`, `require()` and `require.resolve()` form graph edges.
New computed imports/requires, opaque `@Inject(...)` tokens, ModuleRef lookups
and unresolved local imports fail rather than disappearing from the graph.
License markers are `@license Enterprise`; removing a marker from a surviving
baseline file does not remove its protection. New graph edges leading transitively
to a protected file fail, even if the importing file already had another path.
Changes to package identities/exports or tsconfig resolution settings require a
guard update and review; deleting an alias cannot hide a formerly local import.

This is a conservative source guard, **not a TypeScript compiler or runtime DI
proof**. It does not analyze arbitrary reflection/service locators, eval, external
npm package internals, bundler plugins, generated runtime code, or dynamically
constructed registration arrays. JSONC tsconfig aliases and nonstandard package
exports may remain unresolved and are inventoried. It over-approximates type-only
and conditional imports. Existing unresolved/dynamic dependencies remain explicit
baseline debt, not approved production behavior. A newly introduced DI technique
outside these recognized forms requires manual review and parser coverage.

It prevents growth of known source dependencies during ROB-764. ROB-766 and G18
still require removal of baseline dependencies in the selected free runtime,
actual build/module inventory and tests with Enterprise providers absent/throwing.
An unchanged existing call site's behavior cannot be proved from an import graph.
