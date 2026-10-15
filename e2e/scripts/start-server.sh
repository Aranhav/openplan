#!/usr/bin/env bash
# Starts a fresh OpenPlan server for the end-to-end tests: drops and recreates the `openplan_e2e`
# database, then runs the debug binary (build it first: `cargo build -p openplan-server`).
set -euo pipefail

cd "$(dirname "$0")/.."

admin_url="${E2E_ADMIN_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
database="openplan_e2e"

psql "$admin_url" -v ON_ERROR_STOP=1 --quiet \
  -c "DROP DATABASE IF EXISTS $database WITH (FORCE)" \
  -c "CREATE DATABASE $database"

# Swap the database name in the admin URL, keeping any query string.
export DATABASE_URL="$(printf '%s' "$admin_url" | sed -E "s#/[^/?]*(\?|$)#/$database\1#")"
export OPENPLAN_BIND="127.0.0.1:8090"
export OPENPLAN_PUBLIC_URL="http://localhost:8090"

exec ../target/debug/openplan serve
