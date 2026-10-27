#!/usr/bin/env python3
"""Conservative source dependency guard; not a license or runtime proof."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys

PINNED_COMMIT = "729f6236126eddaa68d176fb766bc349b19de11d"
BASELINE = "Research/omnichannel_crm/implementation/enterprise-dependency-baseline.json"
EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
ROOT_PACKAGES = ("twenty-server", "twenty-front", "twenty-shared", "twenty-ui")
LICENSE = re.compile(r"@license\s+Enterprise\b")
TOKEN = re.compile(
    r"(?P<comment>//[^\n]*|/\*[\s\S]*?\*/)"
    r"|(?P<string>'(?:\\[\s\S]|[^'\\])*'|\"(?:\\[\s\S]|[^\"\\])*\")"
    r"|(?P<template>`(?:\\[\s\S]|[^`\\])*`)"
    r"|(?P<word>[A-Za-z_$][\w$]*)|(?P<symbol>[^\s])"
)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def tokens(source: str) -> list[tuple[str, str]]:
    return [(m.lastgroup, m.group()) for m in TOKEN.finditer(source)
            if m.lastgroup != "comment"]


def literal(token: tuple[str, str]) -> str | None:
    kind, value = token
    if kind not in ("string", "template") or (kind == "template" and "${" in value):
        return None
    value = value[1:-1]
    return re.sub(
        r"\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))",
        lambda m: chr(int(m[1] or m[2], 16)) if m[1] or m[2]
        else {"n": "\n", "r": "\r", "t": "\t"}.get(m[3], m[3]), value,
    )


def call_end(parts: list[tuple[str, str]], start: int) -> int:
    depth = 0
    for index in range(start, len(parts)):
        value = parts[index][1]
        if value == "(":
            depth += 1
        elif value == ")":
            depth -= 1
            if depth == 0:
                return index
    return len(parts) - 1


def dependencies(source: str) -> tuple[set[str], Counter[str]]:
    parts = tokens(source)
    imports: set[str] = set()
    opaque: Counter[str] = Counter()
    for index, (kind, value) in enumerate(parts):
        following = parts[index + 1:index + 2]
        if kind == "template" and "${" in value and re.search(r"\b(import|require)\s*\(", value):
            opaque["template-expression:" + digest(value)] += 1
        if kind != "word":
            continue
        if value in ("import", "require"):
            call_start = index + 1
            if value == "require" and [t[1] for t in parts[index + 1:index + 3]] == [".", "resolve"]:
                call_start += 2
            if call_start < len(parts) and parts[call_start][1] == "(":
                end = call_end(parts, call_start)
                args = parts[call_start + 1:end]
                target = literal(args[0]) if args else None
                # A second argument is allowed only for import assertions.
                single = len(args) == 1 or (value == "import" and len(args) > 1 and args[1][1] == ",")
                if target is not None and single:
                    imports.add(target)
                else:
                    opaque["dynamic:" + digest(repr(parts[index:end + 1]))] += 1
            elif value == "import" and following and literal(following[0]) is not None:
                imports.add(literal(following[0]))
        # Covers import/export ... from, including type-only imports.
        if value == "from" and following and literal(following[0]) is not None:
            imports.add(literal(following[0]))
        if value == "Inject" and index and parts[index - 1][1] == "@" and following and following[0][1] == "(":
            end = call_end(parts, index + 1)
            args = parts[index + 2:end]
            if len(args) != 1 or args[0][0] != "word":
                opaque["di-token:" + digest(repr(args))] += 1
        if value.lower() in ("moduleref", "modulereference") and index + 3 < len(parts):
            if parts[index + 1][1] == "." and parts[index + 2][1] in ("get", "resolve", "create"):
                start = index + 3
                if parts[start][1] == "<":
                    depth = 1
                    start += 1
                    while start < len(parts) and depth:
                        depth += (parts[start][1] == "<") - (parts[start][1] == ">")
                        start += 1
                if start < len(parts) and parts[start][1] == "(":
                    end = call_end(parts, start)
                    opaque["di-lookup:" + digest(repr(parts[index:end + 1]))] += 1
    return imports, opaque


def selected(path: str) -> bool:
    return path.startswith("packages/") and (
        path.endswith(EXTENSIONS) or path.endswith(("/package.json", "/tsconfig.json"))
    ) and not any(x in path.split("/") for x in ("node_modules", "dist", ".yarn"))


def read_sources(root: Path, commit: str | None = None) -> dict[str, str]:
    if commit:
        names = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", commit, "--", "packages"], cwd=root).decode().splitlines()
        names = [p for p in names if selected(p)]
        request = "".join(f"{commit}:{p}\n" for p in names).encode()
        raw = subprocess.run(["git", "cat-file", "--batch"], input=request, cwd=root,
                             capture_output=True, check=True).stdout
        result = {}
        offset = 0
        for path in names:
            end = raw.index(b"\n", offset)
            size = int(raw[offset:end].split()[-1])
            result[path] = raw[end + 1:end + 1 + size].decode("utf-8-sig")
            offset = end + size + 2
        return result
    # Git refreshes its working-tree stat information; unchanged content comes
    # from immutable objects instead of opening thousands of OneDrive files.
    result = read_sources(root, PINNED_COMMIT)
    changed = subprocess.check_output(["git", "diff", "--name-only", "--no-renames", PINNED_COMMIT, "--", "packages"], cwd=root).decode().splitlines()
    untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "--", "packages"], cwd=root).decode().splitlines()
    for path in set(changed + untracked):
        if not selected(path):
            continue
        if (root / path).is_file():
            result[path] = (root / path).read_text(encoding="utf-8-sig")
        else:
            result.pop(path, None)
    return result


class SourceGraph:
    def __init__(self, sources: dict[str, str]):
        self.sources = sources
        self.code = {p for p in sources if p.endswith(EXTENSIONS)}
        self.packages = {}
        self.aliases = {}
        self.resolution_config = {}
        for path, source in sources.items():
            if path.count("/") != 2:
                continue
            if path.endswith("/package.json"):
                config = json.loads(source)
                self.packages[config["name"]] = str(PurePosixPath(path).parent)
                self.resolution_config[path] = digest(json.dumps({key: config.get(key) for key in ("name", "exports", "main", "module")}, sort_keys=True))
            elif path.endswith("/tsconfig.json"):
                # Unparseable JSONC configs remain explicit unresolved imports.
                try:
                    config = json.loads(source)
                    options = config.get("compilerOptions", {})
                    self.aliases[str(PurePosixPath(path).parent)] = options.get("paths", {})
                    self.resolution_config[path] = digest(json.dumps({"extends": config.get("extends"), "paths": options.get("paths"), "baseUrl": options.get("baseUrl")}, sort_keys=True))
                except json.JSONDecodeError:
                    self.resolution_config[path] = "unparsed:" + digest(source.replace("\r\n", "\n"))

    def candidates(self, path: str) -> set[str]:
        path = posixpath.normpath(path)
        candidates = [path, *[path + ext for ext in EXTENSIONS],
                      *[path + "/index" + ext for ext in EXTENSIONS]]
        if path.endswith((".js", ".mjs", ".cjs")):
            candidates += [path.rsplit(".", 1)[0] + ext for ext in (".ts", ".tsx", ".mts", ".cts")]
        return {p for p in candidates if p in self.code}

    def resolve(self, source: str, specifier: str) -> tuple[set[str], bool]:
        package = "/".join(source.split("/")[:2])
        if specifier.startswith("."):
            return self.candidates(posixpath.join(posixpath.dirname(source), specifier)), True
        for pattern, targets in self.aliases.get(package, {}).items():
            prefix, _, suffix = pattern.partition("*")
            if ("*" in pattern and specifier.startswith(prefix) and specifier.endswith(suffix)) or specifier == pattern:
                middle = specifier[len(prefix):len(specifier) - len(suffix) if suffix else None]
                found = set()
                for target in targets:
                    found |= self.candidates(posixpath.join(package, target.replace("*", middle)))
                return found, True
        # Packages expose source subpath barrels under src; include all matching candidates.
        for name, directory in self.packages.items():
            if specifier == name or specifier.startswith(name + "/"):
                subpath = specifier[len(name):].lstrip("/")
                return self.candidates(directory + "/src/" + (subpath or "index")), True
        return set(), False

    def inventory(self, retained_enterprise: set[str] | None = None) -> dict:
        enterprise = {p for p in self.code if LICENSE.search(self.sources[p])}
        protected = enterprise | (retained_enterprise or set())
        edges = set()
        opaque = Counter()
        unresolved = set()
        roots = {p for p in self.code if p.startswith(tuple(f"packages/{name}/src/" for name in ROOT_PACKAGES))
                 and not re.search(r"/(?:__tests__|__mocks__)/|\.(?:test|spec|stories|integration-spec)\.", p)}
        for source in sorted(self.code):
            imports, unknown = dependencies(self.sources[source])
            opaque.update({(source, key): count for key, count in unknown.items()})
            for specifier in imports:
                targets, local = self.resolve(source, specifier)
                edges.update((source, target) for target in targets)
                if local and not targets and not re.search(r"\.(?:json|svg|png|jpg|jpeg|gif|css|scss|woff2?|mp3|mp4)(?:\?|$)", specifier):
                    unresolved.add((source, specifier))
        forward, reverse = defaultdict(set), defaultdict(set)
        for source, target in edges:
            forward[source].add(target)
            reverse[target].add(source)

        def closure(initial, graph):
            seen, queue = set(initial), deque(initial)
            while queue:
                for node in graph[queue.popleft()]:
                    if node not in seen:
                        seen.add(node)
                        queue.append(node)
            return seen

        runtime = closure(roots, forward)
        reaches_enterprise = closure(protected, reverse)
        return {
            "enterprise_paths": sorted(enterprise),
            "runtime_enterprise_reachable": sorted(runtime & reaches_enterprise),
            "enterprise_edges": sorted([a, b] for a, b in edges if a in runtime and b in reaches_enterprise),
            "opaque_dependencies": sorted([a, b, count] for (a, b), count in opaque.items() if a in runtime),
            "unresolved_local_imports": sorted([a, b] for a, b in unresolved if a in runtime),
            "resolution_config": self.resolution_config,
            "counts": {"code_files": len(self.code), "runtime_files": len(runtime), "edges": len(edges)},
        }


def violations(baseline: dict, current: dict) -> dict:
    result = {}
    for field in ("runtime_enterprise_reachable", "enterprise_edges", "unresolved_local_imports"):
        old = {json.dumps(x) for x in baseline[field]}
        result[field] = [x for x in current[field] if json.dumps(x) not in old]
    previous_opaque = {(a, b): count for a, b, count in baseline["opaque_dependencies"]}
    result["opaque_dependencies"] = [[a, b, count] for a, b, count in current["opaque_dependencies"]
                                     if count > previous_opaque.get((a, b), 0)]
    result["resolution_config_changes"] = [path for path in sorted(set(baseline["resolution_config"]) | set(current["resolution_config"]))
                                            if baseline["resolution_config"].get(path) != current["resolution_config"].get(path)]
    result["removed_license_markers"] = sorted(set(baseline["enterprise_paths"]) - set(current["enterprise_paths"]))
    return {key: value for key, value in result.items() if value}


def pack_inventory(inventory: dict) -> dict:
    enterprise = set(inventory["enterprise_paths"])
    direct_edges = [(source, target) for source, target in inventory["enterprise_edges"] if target in enterprise]
    paths = set(enterprise)
    for source, target in direct_edges:
        paths.update((source, target))
    paths.update(row[0] for key in ("opaque_dependencies", "unresolved_local_imports") for row in inventory[key])
    paths = sorted(paths)
    identifiers = {path: index for index, path in enumerate(paths)}
    edges = defaultdict(list)
    for source, target in direct_edges:
        edges[identifiers[source]].append(identifiers[target])
    return {
        "paths": paths,
        "enterprise_paths": [identifiers[p] for p in inventory["enterprise_paths"]],
        "direct_enterprise_edges": [[source, targets] for source, targets in sorted(edges.items())],
        "full_inventory_digest": digest(json.dumps(inventory, sort_keys=True, separators=(",", ":"))),
        "enterprise_reachable_count": len(inventory["runtime_enterprise_reachable"]),
        "transitive_enterprise_edge_count": len(inventory["enterprise_edges"]),
        "opaque_dependencies": [[identifiers[a], b, count] for a, b, count in inventory["opaque_dependencies"]],
        "unresolved_local_imports": [[identifiers[a], b] for a, b in inventory["unresolved_local_imports"]],
        "resolution_config": inventory["resolution_config"],
        "counts": inventory["counts"],
    }


def build_baseline(root: Path) -> tuple[dict, dict]:
    sources = read_sources(root, PINNED_COMMIT)
    inventory = SourceGraph(sources).inventory()
    return {"format": 3, "pinned_commit": PINNED_COMMIT,
            "root_packages": list(ROOT_PACKAGES),
            "source_digest": digest("\n".join(p + ":" + digest(sources[p].replace("\r\n", "\n")) for p in sorted(sources))),
            **pack_inventory(inventory)}, inventory


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-baseline", action="store_true", help="Generate only from the hard-pinned upstream commit")
    parser.add_argument("--verify-baseline", action="store_true", help="Explicit spelling of the mandatory pinned baseline verification")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    path = root / BASELINE
    expected, baseline_inventory = build_baseline(root)
    if args.write_baseline:
        path.write_text(json.dumps(expected, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({"baseline_written": BASELINE, "counts": expected["counts"]}))
        return 0
    baseline = json.loads(path.read_text(encoding="utf-8"))
    if baseline != expected:
        raise ValueError("Pinned baseline differs; do not adopt working-tree dependencies as the baseline")
    baseline = baseline_inventory
    sources = read_sources(root)
    current = SourceGraph(sources).inventory(set(baseline["enterprise_paths"]))
    # Deleted files are allowed; deleting just a license marker is not.
    present = set(sources)
    baseline = {**baseline, "enterprise_paths": [p for p in baseline["enterprise_paths"] if p in present]}
    problems = violations(baseline, current)
    print(json.dumps({"status": "fail" if problems else "pass", "counts": current["counts"],
                      "violations": problems, "runtime_license_proof": False}, indent=2))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
