"""Verify LF-normalized generated command bytes against the release manifest."""

import hashlib
import json
from pathlib import Path


def verify_sources(root: Path) -> int:
    manifest_path = root / "packages/twenty-server/src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json"
    entries = json.loads(manifest_path.read_text(encoding="utf-8"))
    command_dir = root / "packages/twenty-server/src/database/commands/fork-upgrade/steps"
    expected_paths = set(command_dir.glob("*.migration.ts"))
    seen = set()
    for entry in entries:
        source = root / entry["sourcePath"]
        if source not in expected_paths or source in seen:
            raise ValueError("Unexpected or duplicate migration source path")
        seen.add(source)
        normalized = source.read_bytes().replace(b"\r\n", b"\n")
        actual = hashlib.sha256(normalized).hexdigest()
        if actual != entry["checksum"]:
            raise ValueError(f"Migration checksum mismatch: {entry['migrationId']}")
        if b"@RegisteredInstanceCommand" in normalized or b"@WasIntroducedInUpgrade" in normalized:
            raise ValueError("Fork command must not participate in upstream discovery")
    if seen != expected_paths or not seen:
        raise ValueError("Migration sources and manifest differ")
    return len(entries)


if __name__ == "__main__":
    print(f"Verified {verify_sources(Path(__file__).resolve().parents[2])} fork migration source(s)")
