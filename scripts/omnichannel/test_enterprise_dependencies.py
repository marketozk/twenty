import unittest

from check_enterprise_dependencies import SourceGraph, dependencies, violations, pack_inventory


SERVER = "packages/twenty-server/"
ENTERPRISE = SERVER + "src/paid.ts"


def fixture(**files):
    return {
        SERVER + "package.json": '{"name":"twenty-server"}',
        SERVER + "tsconfig.json": '{"compilerOptions":{"paths":{"src/*":["./src/*"]}}}',
        ENTERPRISE: "/* @license Enterprise */ export class Paid {}",
        **{SERVER + "src/" + name: body for name, body in files.items()},
    }


class DependencyGuardTest(unittest.TestCase):
    def changes(self, before, after):
        baseline = SourceGraph(before).inventory()
        current = SourceGraph(after).inventory(set(baseline["enterprise_paths"]))
        return violations(baseline, current)

    def test_direct_import_is_rejected(self):
        before = fixture(**{"feature.ts": "export const x = 1"})
        after = {**before, SERVER + "src/feature.ts": "import { Paid } from './paid';"}
        self.assertIn("enterprise_edges", self.changes(before, after))

    def test_safe_new_module_is_allowed(self):
        before = fixture(**{"safe.ts": "export const x = 1"})
        after = {**before, SERVER + "src/new.ts": "import { x } from './safe'"}
        self.assertEqual({}, self.changes(before, after))

    def test_transitive_barrel_and_di_provider_are_rejected(self):
        before = fixture(**{"barrel.ts": "export { Paid } from './paid'"})
        after = {**before, SERVER + "src/module.ts": "import { Paid } from './barrel'; @Module({providers:[Paid]}) export class Module {}"}
        self.assertIn(SERVER + "src/module.ts", self.changes(before, after)["runtime_enterprise_reachable"])

    def test_cycle_reaches_enterprise_without_recursion_error(self):
        sources = fixture(**{"a.ts": "import './b'", "b.ts": "import './a'; import './paid'"})
        graph = SourceGraph(sources).inventory()
        self.assertIn(SERVER + "src/a.ts", graph["runtime_enterprise_reachable"])

    def test_existing_import_is_not_permission_for_new_source(self):
        before = fixture(**{"old.ts": "import './paid'"})
        after = {**before, SERVER + "src/new.ts": "import './old'"}
        self.assertTrue(self.changes(before, after))

    def test_new_path_from_already_tainted_source_is_rejected(self):
        before = fixture(**{"old.ts": "import './paid'", "barrel.ts": "export * from './paid'"})
        after = {**before, SERVER + "src/old.ts": "import './paid'; import './barrel'"}
        self.assertIn("enterprise_edges", self.changes(before, after))

    def test_literal_dynamic_import_and_require_are_edges(self):
        imports, unknown = dependencies("import('./paid'); require('./other'); require.resolve('./third')")
        self.assertEqual({'./paid', './other', './third'}, imports)
        self.assertFalse(unknown)

    def test_computed_dynamic_dependency_is_rejected(self):
        before = fixture()
        for expression in ("import(path)", "require('./' + part)", "import(`./${part}`)"):
            with self.subTest(expression=expression):
                after = {**before, SERVER + "src/new.ts": expression}
                self.assertIn("opaque_dependencies", self.changes(before, after))

    def test_nonliteral_di_is_not_silently_ignored(self):
        before = fixture()
        after = {**before, SERVER + "src/new.ts": "@Inject('paid-token') field; this.moduleRef.get(name);"}
        self.assertEqual(2, len(self.changes(before, after)["opaque_dependencies"]))

    def test_generic_di_lookup_is_inventoried(self):
        _, unknown = dependencies("this.moduleRef.get<SomeProvider>(token)")
        self.assertEqual(1, sum(unknown.values()))

    def test_alias_and_type_only_import_are_conservative_edges(self):
        imports, _ = dependencies("import type { Paid } from 'src/paid';")
        self.assertEqual({'src/paid'}, imports)
        graph = SourceGraph(fixture())
        self.assertEqual(({ENTERPRISE}, True), graph.resolve(SERVER + "src/x.ts", 'src/paid'))

    def test_workspace_package_barrel_resolves(self):
        sources = {**fixture(), "packages/twenty-shared/package.json": '{"name":"twenty-shared"}',
                   "packages/twenty-shared/src/utils/index.ts": "export const x = 1"}
        graph = SourceGraph(sources)
        self.assertEqual(({"packages/twenty-shared/src/utils/index.ts"}, True),
                         graph.resolve(SERVER + "src/x.ts", "twenty-shared/utils"))

    def test_removed_license_marker_does_not_remove_protection(self):
        before = fixture(**{"new.ts": "export const x = 1"})
        after = {**before, ENTERPRISE: "export class Paid {}", SERVER + "src/new.ts": "import './paid'"}
        problems = self.changes(before, after)
        self.assertIn("removed_license_markers", problems)
        self.assertIn("enterprise_edges", problems)

    def test_comments_and_string_text_do_not_create_edges(self):
        imports, unknown = dependencies("// import './paid'\n const text = \"import('./paid')\"; /* require(x) */")
        self.assertFalse(imports)
        self.assertFalse(unknown)

    def test_new_unresolved_local_import_is_rejected(self):
        before = fixture()
        after = {**before, SERVER + "src/new.ts": "import 'src/missing'"}
        self.assertIn("unresolved_local_imports", self.changes(before, after))

    def test_nested_template_import_is_opaque(self):
        _, unknown = dependencies('const text = `${import(path)}`')
        self.assertTrue(unknown)

    def test_escaped_import_literal_cannot_hide_target(self):
        imports, _ = dependencies(r"import './\u0070aid'")
        self.assertEqual({'./paid'}, imports)

    def test_reducing_existing_dynamic_dependency_count_is_allowed(self):
        before = fixture(**{"dynamic.ts": "import(path); import(path)"})
        after = {**before, SERVER + "src/dynamic.ts": "import(path)"}
        self.assertEqual({}, self.changes(before, after))

    def test_alias_removal_cannot_disguise_local_import_as_external(self):
        before = fixture(**{"feature.ts": "import 'src/paid'"})
        after = {**before, SERVER + "tsconfig.json": '{}'}
        self.assertIn("resolution_config_changes", self.changes(before, after))

    def test_compact_manifest_retains_direct_edges_and_hashes_transitive_graph(self):
        graph = SourceGraph(fixture(**{"feature.ts": "import './barrel'", "barrel.ts": "export * from './paid'"})).inventory()
        packed = pack_inventory(graph)
        paths = packed['paths']
        direct = [[paths[a], paths[b]] for a, targets in packed['direct_enterprise_edges'] for b in targets]
        self.assertEqual([[SERVER + 'src/barrel.ts', ENTERPRISE]], direct)
        self.assertEqual(2, packed['transitive_enterprise_edge_count'])
        self.assertEqual(64, len(packed['full_inventory_digest']))


if __name__ == "__main__":
    unittest.main()
