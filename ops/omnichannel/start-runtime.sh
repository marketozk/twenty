#!/bin/sh
set -eu

if [ "${DISABLE_DB_MIGRATIONS:-}" != "true" ]; then
  echo "Runtime requires DISABLE_DB_MIGRATIONS=true and a separate migrator" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "A server or worker command is required" >&2
  exit 1
fi

node dist/database/commands/fork-upgrade/fork-upgrade.cli.js verify
exec "$@"
