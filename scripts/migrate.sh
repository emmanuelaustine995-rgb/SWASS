#!/usr/bin/env bash
# Applies migrations/*.sql in order, once each. Usage: DATABASE_URL=postgres://... scripts/migrate.sh
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
dir="$(cd "$(dirname "$0")/../migrations" && pwd)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"

for f in "$dir"/*.sql; do
  name="$(basename "$f")"
  done_already="$(psql "$DATABASE_URL" -tA -c "SELECT 1 FROM schema_migrations WHERE name = '$name'")"
  if [ -z "$done_already" ]; then
    echo "applying $name"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q --single-transaction -f "$f" \
      -c "INSERT INTO schema_migrations (name) VALUES ('$name')"
  fi
done
echo "migrations up to date"
