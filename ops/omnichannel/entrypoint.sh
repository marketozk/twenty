#!/bin/sh
set -eu

if [ "${1:-}" = "migrate" ]; then
  if [ "$#" -ne 1 ]; then
    echo "The migrator does not accept runtime arguments" >&2
    exit 1
  fi
  exec node dist/database/commands/fork-upgrade/fork-migrator.cli.js
fi

exec /app/omnichannel/start-runtime.sh "$@"
