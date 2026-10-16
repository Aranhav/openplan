#!/usr/bin/env bash
# Starts a fresh OpenPlan server for the end-to-end tests: drops and recreates the database of its
# port, then runs the debug binary (build it first: `cargo build -p openplan-server`). The port is
# E2E_PORT (default 8090); its database is `openplan_e2e` for 8090 and `openplan_e2e_<port>` otherwise.
set -euo pipefail

cd "$(dirname "$0")/.."

admin_url="${E2E_ADMIN_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
port="${E2E_PORT:-8090}"
# The port goes into the database name, which goes into SQL, so only a plain port number is taken.
if [[ ! "$port" =~ ^[1-9][0-9]*$ ]]; then
  echo "E2E_PORT must be a port number, not \"$port\"" >&2
  exit 1
fi
database="openplan_e2e"
if [ "$port" != 8090 ]; then
  database="openplan_e2e_$port"
fi

psql "$admin_url" -v ON_ERROR_STOP=1 --quiet \
  -c "DROP DATABASE IF EXISTS $database WITH (FORCE)" \
  -c "CREATE DATABASE $database"

# The same server and credentials as the admin URL, with the database swapped for ours. The URL is
# taken apart as scheme://authority[/database][?query] by parameter expansion, because the admin
# URL may have no database part at all (postgres://user:pass@host:5432) or carry a query string.
base="${admin_url%%\?*}"
query="${admin_url#"$base"}"
authority="${base#*://}"
authority="${authority%%/*}"
export DATABASE_URL="${base%%://*}://$authority/$database$query"
export OPENPLAN_BIND="127.0.0.1:$port"
export OPENPLAN_PUBLIC_URL="http://localhost:$port"

exec ../target/debug/openplan serve
