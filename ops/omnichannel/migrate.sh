#!/bin/sh
set -eu

: "${PG_DATABASE_URL:?PG_DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"

if [ "${DISABLE_DB_MIGRATIONS:-}" = "true" ]; then
  echo "The migrator requires database migrations to be enabled" >&2
  exit 1
fi

case "${TWENTY_MIGRATION_DATABASE_STATE:?Use the migrator entrypoint}" in
  fresh)
    node dist/database/scripts/setup-db.js
    node dist/command/command.js run-instance-commands --force --include-slow
    ;;
  existing) ;;
  *) echo "Unexpected database initialization state" >&2; exit 1 ;;
esac

node dist/command/command.js cache:flush --strict
node dist/command/command.js upgrade
node dist/command/command.js upgrade:status --strict
node dist/database/commands/fork-upgrade/fork-upgrade.cli.js apply
node dist/command/command.js cache:flush --strict

if [ "${DISABLE_CRON_JOBS_REGISTRATION:-}" != "true" ]; then
  node dist/command/command.js cron:register:all --strict
fi
